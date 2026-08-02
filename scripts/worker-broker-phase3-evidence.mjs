#!/usr/bin/env node
/**
 * Build or replay one bounded, unqualified Phase-3 live-evidence receipt.
 *
 * The input files are the single-line JSON outputs from:
 *   npm run test:installed-worker-mcp -- --write-smoke
 *   npm run test:installed-worker-mcp:two-writer
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  buildPhaseThreeLiveReceipt,
  validatePhaseThreeLiveReceipt,
  writePhaseThreeLiveReceipt
} from "./lib/worker-broker-phase3-evidence.mjs";
import { REPO_ROOT } from "./lib/worker-broker-evidence-core.mjs";

const MAX_INPUT_BYTES = 256 * 1024;
const HELP = `Usage:
  node scripts/worker-broker-phase3-evidence.mjs build --completion <json> --two-writer <json> [--write]
  node scripts/worker-broker-phase3-evidence.mjs verify --receipt <json>

This command never runs Grok. It consumes exact live-runner JSON and emits an
immutable supporting receipt with evidenceClass=supporting-live-unqualified.
Any non-evidence source change requires both live inputs to be rerun.
`;

function fail(code = "E_PHASE3_LIVE_EVIDENCE_INVALID") {
  process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}

function readBoundedJson(file) {
  const absolute = path.resolve(file);
  let descriptor;
  try {
    const pathBefore = fs.lstatSync(absolute, { bigint: true });
    if (!pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || pathBefore.size < 2n
      || pathBefore.size > BigInt(MAX_INPUT_BYTES)) {
      throw new Error("invalid input file");
    }
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW)
      ? fs.constants.O_NOFOLLOW
      : 0;
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const input = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolute, { bigint: true });
    for (const field of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]) {
      if (pathBefore[field] !== opened[field]
        || opened[field] !== after[field]
        || after[field] !== pathAfter[field]) {
        throw new Error("input file changed while reading");
      }
    }
    if (Buffer.byteLength(input, "utf8") !== Number(pathBefore.size)) {
      throw new Error("input file size changed");
    }
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("input must be a JSON object");
    }
    return parsed;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function exactArguments(argv) {
  const mode = argv[0];
  if (mode === "build") {
    const values = { completion: null, twoWriter: null, write: false };
    const seen = new Set();
    for (let index = 1; index < argv.length; index += 1) {
      const token = argv[index];
      if (!new Set(["--completion", "--two-writer", "--write"]).has(token)
        || seen.has(token)) return null;
      seen.add(token);
      if (token === "--write") {
        values.write = true;
        continue;
      }
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        return null;
      }
      index += 1;
      if (token === "--completion") values.completion = value;
      else values.twoWriter = value;
    }
    return values.completion && values.twoWriter
      ? { mode, values }
      : null;
  }
  if (mode === "verify"
    && argv.length === 3
    && argv[1] === "--receipt"
    && typeof argv[2] === "string"
    && argv[2]
    && !argv[2].startsWith("--")) {
    return { mode, values: { receipt: argv[2] } };
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && new Set(["--help", "-h"]).has(argv[0])) {
    process.stdout.write(HELP);
    return;
  }
  const parsed = exactArguments(argv);
  if (!parsed) {
    process.stderr.write(HELP);
    process.exitCode = 2;
    return;
  }
  if (parsed.mode === "verify") {
    const receipt = readBoundedJson(parsed.values.receipt);
    const validation = validatePhaseThreeLiveReceipt(receipt, {
      strict: true,
      root: REPO_ROOT
    });
    if (!validation.ok) {
      fail();
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      phase: receipt.phase,
      evidenceClass: receipt.evidenceClass,
      receiptDigest: receipt.receiptDigest,
      sourceCommit: receipt.source.headCommit,
      gateIds: receipt.gates
    })}\n`);
    return;
  }

  const receipt = buildPhaseThreeLiveReceipt({
    completionEvidence: readBoundedJson(parsed.values.completion),
    twoWriterEvidence: readBoundedJson(parsed.values.twoWriter),
    root: REPO_ROOT,
    strict: true
  });
  const relative = parsed.values.write
    ? writePhaseThreeLiveReceipt(receipt, REPO_ROOT)
    : null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    path: relative,
    phase: receipt.phase,
    evidenceClass: receipt.evidenceClass,
    receiptDigest: receipt.receiptDigest,
    sourceCommit: receipt.source.headCommit,
    gateIds: receipt.gates
  })}\n`);
}

try {
  main();
} catch {
  fail();
}
