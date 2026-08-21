#!/usr/bin/env node

import readline from "node:readline";

import { handleMcpRequest } from "./broker.mjs";
import { tryReadJob } from "../scripts/lib/state.mjs";
import {
  drainAuthorizedPendingDispatches,
  startWorkerDispatchSupervisor
} from "../scripts/lib/worker-dispatch-supervisor.mjs";
import { workerChangeNotification } from "../scripts/lib/worker-mcp-notifications.mjs";
import { projectWorkerHandle } from "../scripts/lib/worker-protocol.mjs";

function send(message) {
  if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
}

const session = { notifyWorkers: false };
function notifyLaunchedWorker(launch) {
  if (!session.notifyWorkers || !launch?.root || !launch?.workerId) return;
  try {
    const note = workerChangeNotification(
      projectWorkerHandle(tryReadJob(launch.root, launch.workerId, process.env), {
        trustHostAuthority: false
      })
    );
    if (note) send(note);
  } catch { /* Recovery never writes diagnostics to MCP stdout. */ }
}

const supervisor = startWorkerDispatchSupervisor({
  env: process.env,
  notifyWorker: notifyLaunchedWorker
});
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  supervisor.stop();
};
lines.once("close", stop);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, () => {
    stop();
    lines.close();
    process.stdin.pause();
  });
}
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    return;
  }
  try {
    send(await handleMcpRequest(message, {
      session,
      emitNotification: session.notifyWorkers ? send : undefined
    }));
    if (message?.method === "tools/call" && message?.params?.name === "worker_spawn") {
      void drainAuthorizedPendingDispatches({
        env: process.env,
        notifyWorker: notifyLaunchedWorker
      }).catch(() => {});
    }
  } catch {
    send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: "Internal error." } });
  }
});
