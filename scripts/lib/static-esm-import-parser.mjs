#!/usr/bin/env node

import crypto from "node:crypto";
import process from "node:process";
import { SourceTextModule } from "node:vm";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCES = 512;

function exactObject(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
  );
}

function moduleSpecifiers(source, identifier) {
  const module = new SourceTextModule(source, { identifier });
  const requests = Array.isArray(module.moduleRequests)
    ? module.moduleRequests.map((request) => request?.specifier)
    : module.dependencySpecifiers;
  if (!Array.isArray(requests) || requests.some((specifier) => typeof specifier !== "string")) {
    throw new Error("Module requests are unavailable.");
  }
  return [...new Set(requests)].sort();
}

async function main() {
  if (typeof SourceTextModule !== "function") throw new Error("VM module parser is unavailable.");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error("Parser input exceeds its limit.");
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  if (!exactObject(payload, ["schemaVersion", "sources"])
    || payload.schemaVersion !== 1
    || !Array.isArray(payload.sources)
    || payload.sources.length < 1
    || payload.sources.length > MAX_SOURCES) {
    throw new Error("Parser input is malformed.");
  }
  const ids = new Set();
  const results = payload.sources.map((entry) => {
    if (!exactObject(entry, ["id", "source"])
      || typeof entry.id !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.id)
      || ids.has(entry.id)
      || typeof entry.source !== "string"
      || Buffer.byteLength(entry.source, "utf8") > MAX_SOURCE_BYTES
      || entry.id !== crypto.createHash("sha256").update(entry.source).digest("hex")) {
      throw new Error("Parser source entry is malformed.");
    }
    ids.add(entry.id);
    return {
      id: entry.id,
      specifiers: moduleSpecifiers(entry.source, `grok-proof-source:${entry.id}`)
    };
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, results })}\n`);
}

try {
  await main();
} catch {
  process.stderr.write("Static ESM dependency parsing failed.\n");
  process.exitCode = 1;
}
