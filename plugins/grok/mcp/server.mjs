#!/usr/bin/env node

import readline from "node:readline";

import { handleMcpRequest } from "./broker.mjs";

function send(message) {
  if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
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
