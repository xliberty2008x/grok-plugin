import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { workspaceState } from "../plugins/grok/scripts/lib/workspace.mjs";

export function cancelIdempotencyFile(root, key, env) {
  const keyDigest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(workspaceState(root, env), "idempotency", "cancel", `${keyDigest}.json`);
}

export function spawnIdempotencyFile(root, key, env) {
  const keyDigest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(workspaceState(root, env), "idempotency", "spawn", `${keyDigest}.json`);
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, canonicalize(value[key])]));
}

export function stableDigest(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function spawnResponseWitnessBody(witness) {
  const { witnessId: _witnessId, ...body } = witness;
  return body;
}

export function refreshSpawnWitnessId(record) {
  record.responseWitness.witnessId = `spawnw-${
    stableDigest(spawnResponseWitnessBody(record.responseWitness)).slice(0, 24)
  }`;
  return record;
}

export function installOversizeGitHook(root, label) {
  const hooksRoot = path.join(root, ".git", "hooks");
  fs.mkdirSync(hooksRoot, { recursive: true });
  const hook = path.join(hooksRoot, `issue55-${label}`);
  fs.writeFileSync(hook, Buffer.alloc((4 * 1024 * 1024) + 1, 0x61));
  return hook;
}
