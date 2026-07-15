import { performance } from "node:perf_hooks";

import { CompanionError } from "./errors.mjs";
import { sameHostSession } from "./host.mjs";
import { listJobsReadonly, tryReadJob } from "./state.mjs";
import {
  isWorkerTerminal,
  projectWorkerHandle,
  projectWorkerLifecycleCursor,
  projectWorkerSnapshot
} from "./worker-protocol.mjs";
import { isCanonicalUuid } from "./worker-authority.mjs";

export const MAX_WORKER_WAIT_MS = 30_000;
const DEFAULT_WORKER_WAIT_MS = 10_000;
const WAIT_POLL_MS = 100;

function notFound() {
  return new CompanionError("E_JOB_NOT_FOUND", "Worker was not found.");
}

function assertServicePrincipal(principal) {
  if (principal?.hostKind !== "codex" || !isCanonicalUuid(principal.threadId)) {
    throw new CompanionError("E_AUTH_REQUIRED", "Trusted Codex task identity is unavailable.");
  }
}

function assertWaitMs(value) {
  const timeoutMs = value == null ? DEFAULT_WORKER_WAIT_MS : value;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WORKER_WAIT_MS) {
    throw new CompanionError("E_USAGE", `Worker wait must be an integer from 0 to ${MAX_WORKER_WAIT_MS} milliseconds.`);
  }
  return timeoutMs;
}

export function createWorkerService({
  root,
  principal,
  env = process.env,
  readJob = tryReadJob,
  listJobs = listJobsReadonly,
  clock = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  assertServicePrincipal(principal);
  if (typeof root !== "string" || !root) {
    throw new CompanionError("E_CAPABILITY", "Trusted Codex workspace metadata is unavailable.");
  }
  const host = Object.freeze({ kind: "codex", sessionId: principal.threadId });

  const ownedJob = (id) => {
    const job = readJob(root, id, env);
    if (!job || !sameHostSession(job, host)) throw notFound();
    return job;
  };

  return Object.freeze({
    listOwned() {
      return listJobs(root, env)
        .filter((job) => sameHostSession(job, host))
        .map((job) => projectWorkerHandle(job));
    },

    get(id) {
      return projectWorkerSnapshot(ownedJob(id));
    },

    eventsAfter(id, cursor = null) {
      const job = ownedJob(id);
      return projectWorkerLifecycleCursor(job, cursor);
    },

    async wait(id, { cursor = null, timeoutMs: requestedTimeoutMs } = {}) {
      const timeoutMs = assertWaitMs(requestedTimeoutMs);
      const deadline = clock() + timeoutMs;
      let latest;
      for (;;) {
        // Re-read and re-authorize on every pass; no recovery or mutation occurs.
        const job = ownedJob(id);
        latest = projectWorkerLifecycleCursor(job, cursor);
        if (latest.events.length || latest.terminal) return { ...latest, timedOut: false };
        const remaining = deadline - clock();
        if (remaining <= 0) return { ...latest, timedOut: true };
        await sleep(Math.min(WAIT_POLL_MS, remaining));
      }
    },

    result(id) {
      const job = ownedJob(id);
      if (!isWorkerTerminal(job)) {
        throw new CompanionError("E_JOB_ACTIVE", "Worker result is not available yet.");
      }
      return projectWorkerSnapshot(job);
    }
  });
}
