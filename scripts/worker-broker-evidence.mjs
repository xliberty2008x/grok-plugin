#!/usr/bin/env node
/**
 * CLI: npm run worker:evidence / worker:verify / worker:qualify
 *
 * Usage:
 *   node scripts/worker-broker-evidence.mjs status [--strict]
 *   node scripts/worker-broker-evidence.mjs verify --phase <N> [--strict]
 *   node scripts/worker-broker-evidence.mjs verify --all [--strict]
 *   node scripts/worker-broker-evidence.mjs capture --phase <N> --slice <id> [--write]
 *   node scripts/worker-broker-evidence.mjs qualify --phase <N> --host <codex|claude-code> [--record]
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  REPO_ROOT,
  buildEvidenceRecord,
  computeInventoryDigest,
  computePhaseScopeDigest,
  evidenceStatus,
  gitIdentity,
  updateLedger,
  validateEvidenceRecord,
  verifyLedger,
  verifyPhase,
  writeEvidenceRecord
} from "./lib/worker-broker-evidence.mjs";

function usage(exitCode = 2) {
  process.stderr.write(`Usage:
  node scripts/worker-broker-evidence.mjs status [--strict]
  node scripts/worker-broker-evidence.mjs verify --phase <N>|--all [--strict]
  node scripts/worker-broker-evidence.mjs capture --phase <N> --slice <id> [--status <s>] [--write]
  node scripts/worker-broker-evidence.mjs qualify --phase <N> --host <codex|claude-code> [--record]
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--strict") args.strict = true;
    else if (token === "--write" || token === "--record") args.write = true;
    else if (token === "--all") args.all = true;
    else if (token === "--phase") args.phase = argv[++i];
    else if (token === "--slice") args.slice = argv[++i];
    else if (token === "--status") args.status = argv[++i];
    else if (token === "--host") args.host = argv[++i];
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--")) usage();
    else args._.push(token);
  }
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(errors) {
  for (const message of errors) process.stderr.write(`${message}\n`);
  process.exit(1);
}

function commandStatus(args) {
  const result = evidenceStatus(REPO_ROOT, { strict: Boolean(args.strict) });
  printJson({
    ok: result.ok,
    errors: result.errors,
    phases: result.phases,
    updatedAt: result.ledger.updatedAt
  });
  if (!result.ok) process.exit(1);
}

function commandVerify(args) {
  if (args.all) {
    const result = verifyLedger(REPO_ROOT, { strict: Boolean(args.strict) });
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  if (!args.phase) usage();
  const result = verifyPhase(args.phase, REPO_ROOT, { strict: Boolean(args.strict) });
  printJson(result);
  if (!result.ok) process.exit(1);
}

function commandCapture(args) {
  if (!args.phase || !args.slice) usage();
  const identity = gitIdentity(REPO_ROOT);
  const verification = [
    {
      command: "npm run check",
      boundary: "source-provider-neutral",
      outcome: "not_run",
      assertions: ["capture records identity; run check separately for gate proof"]
    },
    {
      command: "git identity + inventory digest",
      boundary: "source",
      outcome: identity.cleanTreeAtVerification ? "pass" : "fail",
      assertions: [
        `headCommit=${identity.headCommit}`,
        `clean=${identity.cleanTreeAtVerification}`,
        `sourceDigest=${computeInventoryDigest(REPO_ROOT)}`,
        `phaseScopeDigest=${computePhaseScopeDigest(args.phase, REPO_ROOT)}`
      ]
    }
  ];
  const record = buildEvidenceRecord({
    phase: args.phase,
    slice: args.slice,
    status: args.status || "implemented_unverified",
    verification,
    scenarios: [
      {
        id: "evidence-capture",
        expected: "record validates structurally",
        actual: "built",
        outcome: "pass"
      }
    ],
    limits: {
      residualRisks: ["Live host/provider qualification may be residual."],
      unsupportedPlatforms: ["windows-provider-execution", "linux-provider-unqualified"],
      invalidationTriggers: [
        "non-evidence source change",
        "phase-scope change",
        "dirty tree when claiming clean"
      ],
      supersededBy: null,
      liveQualificationGaps: []
    }
  });
  const validated = validateEvidenceRecord(record);
  if (!validated.ok) fail(validated.errors);
  if (args.write) {
    const relative = writeEvidenceRecord(record, REPO_ROOT);
    updateLedger({
      phase: record.phase,
      slice: record.slice,
      status: record.status,
      path: relative,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      recordedAt: record.recordedAt
    }, REPO_ROOT);
    printJson({ ok: true, path: relative, record });
    return;
  }
  printJson({ ok: true, record });
}

function commandQualify(args) {
  if (!args.phase || !args.host) usage();
  const gaps = [];
  const which = process.platform === "win32" ? "where" : "which";
  const probe = process.platform === "win32" ? "codex.exe" : "codex";
  const probeResult = spawnSync(which, [probe], { encoding: "utf8" });
  if (probeResult.status !== 0) {
    gaps.push(`${args.host} CLI not found on PATH; live qualification residual.`);
  }
  if (!process.env.GROK_E2E && !process.env.XAI_API_KEY) {
    gaps.push("Authenticated Grok credentials not available in this environment.");
  }
  const record = buildEvidenceRecord({
    phase: args.phase,
    slice: `qualify-${args.host}`,
    status: "implemented_unverified",
    verification: [
      {
        command: `worker:qualify --phase ${args.phase} --host ${args.host}`,
        boundary: "live-host",
        outcome: "skip",
        skipMeaning: gaps.length
          ? gaps.join(" ")
          : "Live qualification not executed in capture-only mode."
      }
    ],
    liveScenarios: [
      {
        id: "natural-host-or-provider",
        boundary: args.host,
        outcome: "skip",
        actual: gaps.length ? gaps.join("; ") : "not executed"
      }
    ],
    limits: {
      residualRisks: gaps,
      unsupportedPlatforms: ["windows-provider-execution", "linux-provider-unqualified"],
      invalidationTriggers: [
        "source change",
        "install digest change",
        "host/provider version change"
      ],
      supersededBy: null,
      liveQualificationGaps: gaps
    },
    evidenceSystemQualification: true,
    provisionalSupportingRecord: false,
    releaseQualification: false
  });
  if (args.write) {
    const relative = writeEvidenceRecord(record, REPO_ROOT);
    updateLedger({
      phase: record.phase,
      slice: record.slice,
      status: record.status,
      path: relative,
      recordDigest: record.recordDigest,
      sourceCommit: record.source.headCommit,
      recordedAt: record.recordedAt
    }, REPO_ROOT);
    printJson({ ok: true, path: relative, residualGaps: gaps, record });
    return;
  }
  printJson({ ok: true, residualGaps: gaps, record });
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args._.length) usage(args.help ? 0 : 2);
const command = args._[0];
if (command === "status") commandStatus(args);
else if (command === "verify") commandVerify(args);
else if (command === "capture") commandCapture(args);
else if (command === "qualify") commandQualify(args);
else usage();
