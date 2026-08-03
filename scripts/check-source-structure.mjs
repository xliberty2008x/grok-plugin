#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  evaluateSourceStructure,
  loadSourceStructurePolicy,
  SOURCE_STRUCTURE_POLICY_PATH
} from "./lib/source-structure-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  let json = false;
  let mode = null;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") return { help: true, json, mode };
    else if (arg === "--mode=observe" || arg === "--mode=ratchet") mode = arg.slice("--mode=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, json, mode };
}

function replaceLiteral(value, target, replacement) {
  return target ? value.split(target).join(replacement) : value;
}

function portableIdentifier(value, root) {
  if (typeof value !== "string") return null;
  if (!path.isAbsolute(value)) return value.replace(/\\/gu, "/");
  const relative = path.relative(root, value);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/gu, "/");
  }
  return "<absolute-path>";
}

function publicMessage(value, root) {
  let message = String(value ?? "");
  const absoluteRoot = path.resolve(root);
  for (const candidate of new Set([
    absoluteRoot,
    absoluteRoot.replace(/\\/gu, "/"),
    absoluteRoot.replace(/\//gu, "\\")
  ])) {
    message = replaceLiteral(message, candidate, "<root>");
  }
  return message;
}

function publicFinding(entry, root) {
  const projected = {
    code: String(entry?.code ?? "unknown"),
    file: portableIdentifier(entry?.file, root),
    message: publicMessage(entry?.message, root)
  };
  if (Array.isArray(entry?.cycle)) {
    projected.cycle = entry.cycle.map((file) => portableIdentifier(file, root)).sort();
  }
  if (typeof entry?.functionKey === "string") projected.functionKey = entry.functionKey;
  return projected;
}

function sortedFindings(entries, root) {
  return entries.map((entry) => publicFinding(entry, root)).sort((left, right) => (
    left.code.localeCompare(right.code)
      || String(left.file).localeCompare(String(right.file))
      || left.message.localeCompare(right.message)
      || String(left.functionKey || "").localeCompare(String(right.functionKey || ""))
      || JSON.stringify(left.cycle || []).localeCompare(JSON.stringify(right.cycle || []))
  ));
}

export function publicSourceStructureResult(result, { root = ROOT } = {}) {
  const errors = sortedFindings(result.errors || [], root);
  const warnings = sortedFindings(result.warnings || [], root);
  const cycles = (result.cycles || []).map((cycle) => (
    cycle.map((file) => portableIdentifier(file, root)).sort()
  )).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const fragments = (result.fragments || [])
    .map((file) => portableIdentifier(file, root))
    .sort();
  return {
    schemaVersion: 1,
    ok: result.ok === true,
    mode: String(result.mode ?? "unknown"),
    summary: {
      scannedFiles: Array.isArray(result.files) ? result.files.length : 0,
      errors: errors.length,
      warnings: warnings.length,
      cycles: cycles.length,
      fragments: fragments.length
    },
    errors,
    warnings,
    cycles,
    fragments
  };
}

function printHuman(result, { stdout = process.stdout, stderr = process.stderr } = {}) {
  for (const entry of result.errors) {
    stderr.write(`ERROR${entry.file ? ` [${entry.file}]` : ""}: ${entry.message}\n`);
  }
  for (const entry of result.warnings) {
    stderr.write(`WARN${entry.file ? ` [${entry.file}]` : ""}: ${entry.message}\n`);
  }
  if (result.ok) {
    stdout.write(`Source-structure policy passed in ${result.mode} mode (${result.files.length} files, ${result.warnings.length} warning(s)).\n`);
  } else {
    stderr.write(`Source-structure policy failed with ${result.errors.length} error(s).\n`);
  }
}

export function main(argv = process.argv.slice(2), {
  root = ROOT,
  stdout = process.stdout,
  stderr = process.stderr,
  loadPolicy = loadSourceStructurePolicy,
  evaluate = evaluateSourceStructure
} = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    stderr.write("Usage: node scripts/check-source-structure.mjs [--json] [--mode=observe|--mode=ratchet]\n");
    return 1;
  }
  if (options.help) {
    stdout.write("Usage: node scripts/check-source-structure.mjs [--json] [--mode=observe|--mode=ratchet]\n");
    return 0;
  }
  let config;
  try {
    config = loadPolicy({ root, policyPath: SOURCE_STRUCTURE_POLICY_PATH });
  } catch (error) {
    const result = {
      errors: [{ code: "policy-load-error", file: SOURCE_STRUCTURE_POLICY_PATH, message: error.message, severity: "error" }],
      files: [], mode: options.mode || "unknown", ok: false, warnings: []
    };
    if (options.json) stdout.write(`${JSON.stringify(publicSourceStructureResult(result, { root }), null, 2)}\n`);
    else printHuman(result, { stdout, stderr });
    return 1;
  }
  const result = evaluate({ root, config, mode: options.mode || config.mode });
  if (options.json) stdout.write(`${JSON.stringify(publicSourceStructureResult(result, { root }), null, 2)}\n`);
  else printHuman(result, { stdout, stderr });
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) process.exitCode = main();
