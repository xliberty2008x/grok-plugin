#!/usr/bin/env node

import readline from "node:readline";

import { handleMcpRequest } from "./broker.mjs";
import { startWorkerDispatchSupervisor } from "../scripts/lib/worker-dispatch-supervisor.mjs";

function send(message) {
  if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
}

const supervisor = startWorkerDispatchSupervisor({ env: process.env });
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
    send(await handleMcpRequest(message));
  } catch {
    send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: "Internal error." } });
  }
});
