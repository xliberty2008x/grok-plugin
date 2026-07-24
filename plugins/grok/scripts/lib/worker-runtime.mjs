import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { CompanionError } from "./errors.mjs";
import {
  cleanupTaskRuntimeArtifacts,
  processStartToken
} from "./grok-provider.mjs";
import { runSystemPs } from "./process-control.mjs";
import { pluginDataRoot } from "./host.mjs";
import { loadProviderGuard } from "./recursion-guard.mjs";
import {
  isCancelRequested,
  terminal,
  withWorkspaceStateTransaction
} from "./state.mjs";
import { appendLifecycleEvent } from "./task-contract.mjs";
import {
  assertMutationOwnership,
  claimWorkerDispatch,
  prepareDispatchProcessSpawn,
  providerLaunchState,
  recordDispatchProcessNoChild,
  transitionWorkerDispatch
} from "./worker-mutation.mjs";
import { workspaceState } from "./workspace.mjs";

const COMPANION_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../grok-companion.mjs"
);

const BASE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "ComSpec",
  "PATHEXT"
]);

const GROK_CONFIGURATION_KEYS = Object.freeze([
  "GROK_BIN",
  "GROK_AUTH_PATH",
  "GROK_COMPANION_PLUGIN_DATA",
  "GROK_HEADLESS_PROMPT_ON_DISK",
  "CI",
  "GITHUB_ACTIONS"
]);

const CONTROLLER_TOKEN_WAIT_MS = 150;
const CONTROLLER_TERM_WAIT_MS = 250;
const CONTROLLER_KILL_WAIT_MS = 750;
const CONTROLLER_POLL_MS = 10;

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function signalDetachedProcess(child, signal) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new CompanionError("E_PROCESS_IDENTITY", "Controller process handle has no valid PID.");
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/*
 * A synchronously killed child is briefly observable as a zombie until Node's
 * event loop reaps it. Zombies cannot execute or retain descendants. Inspect
 * every member of the detached process group so terminal publication is not
 * gated merely on the leader PID while a live child remains.
 */
function controllerGroupExecutionGone(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  if (process.platform === "win32") {
    try {
      process.kill(processGroupId, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }
  if (process.platform === "linux") {
    try {
      const states = fs.readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .flatMap((entry) => {
          try {
            const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
            const suffix = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
            return Number(suffix[2]) === processGroupId ? [suffix[0]] : [];
          } catch {
            return [];
          }
        });
      return states.length === 0 || states.every((state) => state === "Z");
    } catch {
      return false;
    }
  }
  const run = runSystemPs(["-o", "stat=", "-g", String(processGroupId)], {
    encoding: "utf8",
    timeout: 1_000
  });
  if (run.error) return false;
  const states = String(run.stdout || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (states.length === 0) return run.status === 0 || run.status === 1;
  return states.every((state) => /^Z/.test(state));
}

function waitForControllerGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let priorGoneObservation = false;
  while (Date.now() < deadline) {
    const gone = controllerGroupExecutionGone(processGroupId);
    if (gone && priorGoneObservation) return true;
    priorGoneObservation = gone;
    sleepSync(Math.min(CONTROLLER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return priorGoneObservation && controllerGroupExecutionGone(processGroupId);
}

function acquireControllerStartToken(child, readStartToken) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const deadline = Date.now() + CONTROLLER_TOKEN_WAIT_MS;
  do {
    const token = readStartToken(pid);
    if (typeof token === "string" && token) return token;
    sleepSync(CONTROLLER_POLL_MS);
  } while (Date.now() < deadline);
  const token = readStartToken(pid);
  return typeof token === "string" && token ? token : null;
}

/**
 * Stop a controller created by this exact live ChildProcess handle. A complete
 * birth token is preferred and checked against PID reuse. Before durable
 * registration, a missing token is not replaced or forged: the retained spawn
 * handle is the sole authority and the cleanup result records that limitation.
 */
export function terminateControllerProcess(child, {
  startToken = null,
  readStartToken = processStartToken,
  signalProcess = signalDetachedProcess,
  termTimeoutMs = CONTROLLER_TERM_WAIT_MS,
  killTimeoutMs = CONTROLLER_KILL_WAIT_MS
} = {}) {
  const pid = Number(child?.pid);
  const processGroupId = process.platform === "win32" ? pid : pid;
  const evidence = {
    ok: false,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    processGroupId: Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : null,
    birthTokenCaptured: typeof startToken === "string" && startToken.length > 0,
    authority: typeof startToken === "string" && startToken.length > 0
      ? "birth-token-and-live-child-handle"
      : "live-child-handle-before-registration",
    signals: []
  };
  if (!Number.isInteger(pid) || pid <= 0 || !child) {
    return {
      ...evidence,
      warning: "Controller cleanup could not be verified because the spawn handle has no valid PID."
    };
  }
  if (waitForControllerGroupExit(processGroupId, 25)) {
    return { ...evidence, ok: true, processGroupGone: true };
  }

  if (evidence.birthTokenCaptured) {
    const currentToken = readStartToken(pid);
    if (currentToken && currentToken !== startToken) {
      return {
        ...evidence,
        warning: "Controller cleanup was refused because the PID birth token changed."
      };
    }
  } else if (child.exitCode !== null || child.signalCode !== null) {
    return {
      ...evidence,
      warning: "Controller cleanup was refused because the unregistered child handle had already exited without group-exit proof."
    };
  }

  try {
    signalProcess(child, "SIGTERM");
    evidence.signals.push("SIGTERM");
    if (!waitForControllerGroupExit(processGroupId, termTimeoutMs)) {
      // Re-check a captured birth token before escalating. A non-empty mismatch
      // is PID reuse and is never permission to signal the group.
      if (evidence.birthTokenCaptured) {
        const currentToken = readStartToken(pid);
        if (currentToken && currentToken !== startToken) {
          return {
            ...evidence,
            warning: "Controller SIGKILL was refused because the PID birth token changed after SIGTERM."
          };
        }
      } else if (child.exitCode !== null || child.signalCode !== null) {
        return {
          ...evidence,
          warning: "Controller SIGKILL was refused because the unregistered child handle exited without group-exit proof."
        };
      }
      signalProcess(child, "SIGKILL");
      evidence.signals.push("SIGKILL");
      if (!waitForControllerGroupExit(processGroupId, killTimeoutMs)) {
        return {
          ...evidence,
          warning: "Controller process-group cleanup remained unverified after SIGKILL."
        };
      }
    }
    return { ...evidence, ok: true, processGroupGone: true };
  } catch (error) {
    return {
      ...evidence,
      warning: `Controller process-group cleanup could not be verified (${error?.code || "unknown"}).`
    };
  }
}

function durableLaunchError(error) {
  const code = /^E_[A-Z0-9_]+$/.test(String(error?.code || ""))
    ? String(error.code)
    : "E_WORKER_LOST";
  const message = code === "E_CANCELLED"
    ? "Grok job was cancelled before provider startup."
    : code === "E_PROCESS_IDENTITY"
      ? "Could not establish the worker controller process identity."
      : "Could not launch the isolated Grok worker controller.";
  return { code, message };
}

function pendingTerminalFor(error, at) {
  const cancelled = error?.code === "E_CANCELLED";
  return {
    status: cancelled ? "cancelled" : "failed",
    phase: cancelled ? "cancelled" : "failed",
    completedAt: at,
    summary: cancelled ? "Cancelled" : "Worker launch failed",
    error
  };
}

function sameControllerIdentity(stored, expected) {
  return Boolean(
    stored?.pid
    && expected?.pid
    && stored.pid === expected.pid
    && stored.startToken === expected.startToken
    && stored.processGroupId === expected.processGroupId
    && stored.nonce === expected.nonce
    && stored.commandMarker === expected.commandMarker
    && stored.dispatchAttemptId === expected.dispatchAttemptId
    && stored.dispatchFence === expected.dispatchFence
  );
}

/*
 * Hold the workspace state transaction while checking eligibility, stopping
 * the controller, and persisting cleanup evidence. That prevents the child
 * from advancing this attempt to worker-started between the exact-state check
 * and the signal. The terminal transition intentionally happens only after
 * this transaction has durably recorded a proven exit.
 */
function prepareControllerFailureSettlement({
  root,
  workerId,
  principal,
  attemptId,
  fence,
  nonce,
  child,
  birthToken,
  error,
  readStartToken,
  signalProcess,
  env
}) {
  return withWorkspaceStateTransaction(root, (transaction) => {
    const current = transaction.tryReadJob(workerId);
    if (!current) throw new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
    assertMutationOwnership(current, principal);
    const dispatch = current.request?.spawn?.dispatch;
    if (dispatch?.attemptId !== attemptId
      || (dispatch?.schemaVersion === 2 && dispatch.fence !== fence)
      || terminal(current)) {
      // This live handle still proves the process we just created even when a
      // concurrent durable state change means this launcher may not publish a
      // settlement. Stop the stale controller, but never rewrite the newer or
      // already-terminal attempt.
      const cleanup = child
        ? terminateControllerProcess(child, {
          startToken: birthToken,
          readStartToken,
          signalProcess
        })
        : null;
      return { eligible: false, job: current, cleanup };
    }

    const controllerProcess = child && birthToken ? {
      pid: child.pid,
      startToken: birthToken,
      nonce,
      processGroupId: process.platform === "win32" ? null : child.pid,
      commandMarker: workerId,
      dispatchAttemptId: attemptId,
      dispatchFence: fence
    } : null;
    const claimed = dispatch.state === "claimed"
      && !current.controllerProcess?.pid
      && !current.workerProcess?.pid
      && !current.providerProcess?.pid;
    const controllerStarted = dispatch.state === "controller-started"
      && controllerProcess
      && sameControllerIdentity(current.controllerProcess, controllerProcess)
      && !current.workerProcess?.pid
      && !current.providerProcess?.pid;
    if (!claimed && !controllerStarted) {
      return { eligible: false, job: current, cleanup: null };
    }

    const controllerCleanup = child
      ? terminateControllerProcess(child, {
        startToken: birthToken,
        readStartToken,
        signalProcess
      })
      : {
        ok: true,
        pid: null,
        processGroupId: null,
        birthTokenCaptured: false,
        authority: "no-controller-created",
        signals: [],
        processGroupGone: true
      };
    let cleanup = controllerCleanup;
    if (controllerCleanup.ok) {
      let guardAbsent = false;
      try { guardAbsent = loadProviderGuard(root, current.id) === null; }
      catch { guardAbsent = false; }
      const taskCleanup = guardAbsent
        ? cleanupTaskRuntimeArtifacts(
            workspaceState(root, env),
            current.request?.providerHomeId || current.id,
            []
          )
        : {
            ok: false,
            warning: "Provider ownership metadata makes task-runtime cleanup ambiguous."
          };
      cleanup = taskCleanup.ok
        ? { ...controllerCleanup, taskRuntimeCleaned: true }
        : {
            ...controllerCleanup,
            ok: false,
            taskRuntimeCleaned: false,
            warning: taskCleanup.warning || "Task runtime artifact cleanup could not be verified."
          };
    }
    const recordedAt = new Date().toISOString();
    const message = cleanup.ok
      ? "Controller process-group exit was verified before launch failure publication."
      : "Worker controller cleanup is blocked because exact process-group exit could not be verified.";
    const next = transaction.updateJob(workerId, (latest) => {
      const latestDispatch = latest.request?.spawn?.dispatch;
      const latestControllerIntent = latest.request?.spawn?.controllerSpawnIntent;
      const latestClaimed = latestDispatch?.state === "claimed"
        && !latest.controllerProcess?.pid
        && !latest.workerProcess?.pid
        && !latest.providerProcess?.pid;
      const latestControllerStarted = latestDispatch?.state === "controller-started"
        && controllerProcess
        && sameControllerIdentity(latest.controllerProcess, controllerProcess)
        && !latest.workerProcess?.pid
        && !latest.providerProcess?.pid;
      if (terminal(latest)
        || latestDispatch?.attemptId !== attemptId
        || (latestDispatch?.schemaVersion === 2 && latestDispatch.fence !== fence)
        || (!latestClaimed && !latestControllerStarted)) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Controller dispatch identity changed before cleanup evidence publication."
        );
      }
      return {
        ...latest,
        ...(!cleanup.ok ? {
          status: "running",
          phase: "cleanup-blocked",
          summary: "Controller cleanup blocked",
          progress: message,
          completedAt: null,
          error: {
            code: "E_PROCESS_IDENTITY",
            message
          },
          pendingTerminal: pendingTerminalFor(error, recordedAt)
        } : {}),
        request: {
          ...latest.request,
          spawn: {
            ...latest.request?.spawn,
            ...(controllerCleanup.ok && latestControllerIntent ? {
              controllerSpawnIntent: {
                ...latestControllerIntent,
                status: "no-child",
                resolution: child ? "cleanup-proven" : "spawn-not-created",
                noChildAt: latestControllerIntent.noChildAt || recordedAt,
                updatedAt: recordedAt
              }
            } : {}),
            // An unverified controller is still an in-flight launch boundary.
            // Keep it nonterminal so cancel/recovery cannot mistake it for a
            // broker-only queued job with no process.
            ...(!controllerCleanup.ok ? {
              providerLaunchPending: false,
              providerLaunchInFlight: true,
              providerLaunchOutcome: "pending",
              providerLaunchCompletedAt: null,
              controllerCleanupPending: true,
              controllerCleanupProcess: child?.pid ? {
                pid: child.pid,
                startToken: birthToken || null,
                processGroupId: process.platform === "win32" ? null : child.pid,
                nonce,
                commandMarker: workerId,
                dispatchAttemptId: attemptId,
                dispatchFence: fence
              } : null
            } : {
              controllerCleanupPending: false,
              controllerCleanupProcess: null
            })
          }
        },
        result: {
          ...(latest.result || {}),
          hostVerification: latest.result?.hostVerification || "not_run",
          taskRuntimeCleaned: cleanup.ok,
          ...(!cleanup.ok ? {
            privacyWarning: cleanup.warning || "Controller process-group cleanup remained unverified."
          } : {}),
          runtimeEvidence: {
            ...(latest.result?.runtimeEvidence || {}),
            controllerTeardown: {
              ...controllerCleanup,
              attemptId,
              recordedAt,
              terminalPublished: false
            }
          }
        },
        lifecycleEvents: appendLifecycleEvent(
          latest.lifecycleEvents || [],
          cleanup.ok ? "checkpoint" : "blocked",
          message,
          {
            dispatchAttemptId: attemptId,
            processGroupGone: cleanup.ok,
            terminalPublished: false
          }
        )
      };
    });
    return { eligible: true, job: next, cleanup };
  }, env);
}

function settleControllerLaunchFailure(options) {
  const error = durableLaunchError(options.error);
  const prepared = prepareControllerFailureSettlement({ ...options, error });
  if (!prepared.eligible || !prepared.cleanup?.ok) return prepared.job;
  const transitioned = transitionWorkerDispatch({
    root: options.root,
    workerId: options.workerId,
    attemptId: options.attemptId,
    fence: options.fence,
    state: "failed",
    error,
    runtimeCleanup: prepared.cleanup,
    env: options.env
  });
  try { options.child?.unref?.(); } catch {}
  return transitioned;
}

/**
 * Build the controller environment from the broker's attested principal. Host
 * identity is never inherited from caller arguments or ambient host metadata.
 */
export function trustedWorkerEnvironment({
  principal,
  nonce,
  attemptId,
  fence = null,
  env = process.env
} = {}) {
  if (!new Set(["codex", "claude-code"]).has(principal?.hostKind)
    || !principal.threadId
    || !nonce
    || !attemptId) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted host task identity is unavailable.");
  }
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if ((BASE_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_")) && value != null) {
      childEnv[key] = value;
    }
  }
  for (const key of GROK_CONFIGURATION_KEYS) {
    if (env[key] != null) childEnv[key] = env[key];
  }
  // Normalize every supported host storage alias to the one explicit variable
  // the detached controller consumes. Service-provided state always wins over
  // ambient process.env.
  childEnv.GROK_COMPANION_PLUGIN_DATA = pluginDataRoot(env);
  childEnv.GROK_COMPANION_HOST = principal.hostKind;
  childEnv.GROK_COMPANION_HOST_SESSION_ID = principal.threadId;
  if (principal.hostKind === "codex") childEnv.CODEX_THREAD_ID = principal.threadId;
  childEnv.GROK_COMPANION_WORKER_NONCE = nonce;
  childEnv.GROK_COMPANION_DISPATCH_ATTEMPT = attemptId;
  if (Number.isSafeInteger(fence) && fence > 0) {
    childEnv.GROK_COMPANION_DISPATCH_FENCE = String(fence);
  }
  return childEnv;
}

/**
 * Claim and launch one committed worker controller. A replay observes the
 * durable claim and never creates another process, including after restart.
 */
export function launchCommittedWorker({
  root,
  workerId,
  principal,
  env = process.env,
  spawnProcess = spawn,
  companionScript = COMPANION_SCRIPT,
  executable = process.execPath,
  startToken = processStartToken,
  terminateProcess = signalDetachedProcess
} = {}) {
  const claim = claimWorkerDispatch({ root, workerId, principal, env });
  if (!claim.claimed) {
    const launchState = providerLaunchState(claim.job);
    return Object.freeze({
      claimed: false,
      providerLaunchState: launchState,
      providerLaunched: launchState === "started"
    });
  }
  const executionRoot = claim.job.request?.spawn?.executionRoot;

  let child;
  let birthToken = null;
  let controllerIntent = null;
  const recordNoController = () => {
    if (!controllerIntent || Number.isInteger(child?.pid)) return;
    recordDispatchProcessNoChild({
      root,
      workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      processKind: "controller",
      intentId: controllerIntent.intentId,
      resolution: "spawn-not-created",
      env
    });
  };
  const failLaunch = (error) => settleControllerLaunchFailure({
    root,
    workerId,
    principal,
    attemptId: claim.attemptId,
    fence: claim.fence,
    nonce: claim.nonce,
    child,
    birthToken,
    error,
    readStartToken: startToken,
    signalProcess: terminateProcess,
    env
  });
  try {
    if (isCancelRequested(root, workerId, claim.nonce, env)) {
      const transitioned = failLaunch({
        code: "E_CANCELLED",
        message: "Grok job was cancelled before worker controller creation."
      });
      return Object.freeze({
        claimed: true,
        providerLaunchState: providerLaunchState(transitioned),
        providerLaunched: false
      });
    }
    const prepared = prepareDispatchProcessSpawn({
      root,
      workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      processKind: "controller",
      nonce: claim.nonce,
      env
    });
    if (!prepared.prepared) {
      const launchState = providerLaunchState(prepared.job);
      return Object.freeze({
        claimed: true,
        providerLaunchState: launchState,
        providerLaunched: launchState === "started"
      });
    }
    controllerIntent = prepared.intent;
    child = spawnProcess(executable, [
      companionScript,
      "--launch-worker",
      workerId,
      "--attempt",
      claim.attemptId,
      "--fence",
      String(claim.fence),
      "--controller-intent",
      controllerIntent.intentId,
      "--cwd",
      executionRoot
    ], {
      cwd: executionRoot,
      detached: true,
      shell: false,
      stdio: "ignore",
      env: trustedWorkerEnvironment({
        principal,
        nonce: claim.nonce,
        attemptId: claim.attemptId,
        fence: claim.fence,
        env
      })
    });
    child?.once?.("error", (error) => {
      try {
        recordNoController();
        failLaunch(error);
      } catch {
        /* A later provider-started settlement wins over a stale error event. */
      }
    });
    if (!Number.isInteger(child?.pid) || child.pid <= 0) {
      recordNoController();
      throw new CompanionError("E_WORKER_LOST", "Could not launch the isolated Grok worker controller.");
    }
    birthToken = acquireControllerStartToken(child, startToken);
    if (typeof birthToken !== "string" || !birthToken) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Could not record the worker controller birth token before startup."
      );
    }
    if (isCancelRequested(root, workerId, claim.nonce, env)) {
      const transitioned = failLaunch({
        code: "E_CANCELLED",
        message: "Grok job was cancelled before worker controller startup."
      });
      return Object.freeze({
        claimed: true,
        providerLaunchState: providerLaunchState(transitioned),
        providerLaunched: false
      });
    }
    const controllerProcess = {
      pid: child.pid,
      startToken: birthToken,
      nonce: claim.nonce,
      processGroupId: process.platform === "win32" ? null : child.pid,
      commandMarker: workerId,
      dispatchAttemptId: claim.attemptId,
      dispatchFence: claim.fence
    };
    const transitioned = transitionWorkerDispatch({
      root,
      workerId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      state: "controller-started",
      controllerProcess,
      spawnIntentId: controllerIntent.intentId,
      env
    });
    if (terminal(transitioned)
      || transitioned.request?.spawn?.dispatch?.attemptId !== claim.attemptId
      || transitioned.request?.spawn?.dispatch?.state !== "controller-started") {
      const settled = failLaunch(new CompanionError(
        "E_WORKER_LOST",
        "Worker controller dispatch changed before startup publication."
      ));
      const launchState = providerLaunchState(settled);
      return Object.freeze({
        claimed: true,
        providerLaunchState: launchState,
        providerLaunched: launchState === "started"
      });
    }
    child.unref?.();
    const launchState = providerLaunchState(transitioned);
    return Object.freeze({
      claimed: true,
      providerLaunchState: launchState,
      providerLaunched: launchState === "started"
    });
  } catch (error) {
    try { recordNoController(); } catch {}
    const transitioned = failLaunch(error);
    const launchState = providerLaunchState(transitioned);
    return Object.freeze({
      claimed: true,
      providerLaunchState: launchState,
      providerLaunched: false
    });
  }
}
