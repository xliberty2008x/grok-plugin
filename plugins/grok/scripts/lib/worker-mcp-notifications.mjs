/** Bounded owned-worker change notifications (#134). */

export const WORKER_CHANGE_NOTIFICATION_METHOD = "notifications/grok/worker_changed";
export const WORKER_CHANGE_NOTIFICATION_CAPABILITY = "grok/worker-change-notifications";

export function clientAcceptsWorkerChangeNotifications(params) {
  const experimental = params?.capabilities?.experimental;
  return Boolean(
    experimental
    && typeof experimental === "object"
    && !Array.isArray(experimental)
    && Object.hasOwn(experimental, WORKER_CHANGE_NOTIFICATION_CAPABILITY)
  );
}

export function workerChangeNotification(worker) {
  if (!worker?.id) return null;
  return Object.freeze({
    jsonrpc: "2.0",
    method: WORKER_CHANGE_NOTIFICATION_METHOD,
    params: Object.freeze({
      workerId: worker.id,
      cursor: worker.updatedAt || worker.heartbeatAt || null,
      phase: worker.phase || null,
      status: worker.status || null,
      terminal: worker.terminal === true
    })
  });
}
