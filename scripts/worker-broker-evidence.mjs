#!/usr/bin/env node
/**
 * CLI: npm run worker:evidence / worker:verify / worker:qualify
 *
 * Usage:
 *   node scripts/worker-broker-evidence.mjs status [--strict]
 *   node scripts/worker-broker-evidence.mjs verify --phase <N> [--strict]
 *   node scripts/worker-broker-evidence.mjs verify --all [--strict] [--require-complete]
 *   node scripts/worker-broker-evidence.mjs capture --phase <N> --slice <id> [--write]
 *   node scripts/worker-broker-evidence.mjs prove --phase 0 --slice <slug> [--write]
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
  provePhaseZero,
  sha256Text,
  updateLedger,
  validateEvidenceRecord,
  verifyLedger,
  verifyPhase,
  writeEvidenceRecord
} from "./lib/worker-broker-evidence.mjs";

function usage(exitCode = 2) {
  process.stderr.write(`Usage:
  node scripts/worker-broker-evidence.mjs status [--strict]
  node scripts/worker-broker-evidence.mjs verify --phase <N>|--all [--strict] [--require-complete]
  node scripts/worker-broker-evidence.mjs capture --phase <N> --slice <id> [--status <s>] [--write]
  node scripts/worker-broker-evidence.mjs prove --phase 0 --slice <bounded-slug> [--write]
  node scripts/worker-broker-evidence.mjs qualify --phase <N> --host <codex|claude-code> [--record]
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--strict") args.strict = true;
    else if (token === "--require-complete") args.requireComplete = true;
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

function parseProveArgs(argv) {
  const args = { phase: null, slice: null, write: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!new Set(["--phase", "--slice", "--write"]).has(token) || seen.has(token)) usage();
    seen.add(token);
    if (token === "--write") {
      args.write = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || !value || value.startsWith("--")) usage();
    index += 1;
    if (token === "--phase") args.phase = value;
    else args.slice = value;
  }
  if (args.phase !== "0"
    || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(args.slice || "")) usage();
  return args;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(errors) {
  for (const message of errors) process.stderr.write(`${message}\n`);
  process.exit(1);
}

function publishRecord(record) {
  try {
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
    return relative;
  } catch {
    fail(["Evidence publication failed safely."]);
  }
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
    const result = verifyLedger(REPO_ROOT, {
      strict: Boolean(args.strict),
      requireComplete: Boolean(args.requireComplete)
    });
    printJson(result);
    if (!result.ok) process.exit(1);
    return;
  }
  if (args.requireComplete) usage();
  if (!args.phase) usage();
  const result = verifyPhase(args.phase, REPO_ROOT, { strict: Boolean(args.strict) });
  printJson(result);
  if (!result.ok) process.exit(1);
}

function commandCapture(args) {
  if (!args.phase || !args.slice) usage();
  const status = args.status || "implemented_unverified";
  if (["verified_on_draft", "qualified"].includes(status)) {
    fail([
      `capture cannot create ${status} evidence from identity-only observations.`,
      "Run the required gates and ingest their bounded command outcomes through a proof-producing workflow."
    ]);
  }
  const identity = gitIdentity(REPO_ROOT);
  const observedAt = new Date().toISOString();
  const identityAssertions = [
    `headCommit=${identity.headCommit}`,
    `clean=${identity.cleanTreeAtVerification}`,
    `sourceDigest=${computeInventoryDigest(REPO_ROOT)}`,
    `phaseScopeDigest=${computePhaseScopeDigest(args.phase, REPO_ROOT)}`
  ];
  const verification = [
    {
      gateId: "repository-check",
      command: "npm run check",
      boundary: "source-provider-neutral",
      outcome: "not_run",
      skipMeaning: "Identity-only capture does not execute repository checks.",
      assertions: ["capture records identity; run check separately for gate proof"]
    },
    {
      gateId: "source-identity",
      command: "git identity + inventory digest",
      boundary: "source",
      outcome: identity.cleanTreeAtVerification ? "pass" : "fail",
      startedAt: observedAt,
      endedAt: observedAt,
      exitCode: identity.cleanTreeAtVerification ? 0 : 1,
      outputDigest: sha256Text(identityAssertions.join("\n")),
      assertions: identityAssertions
    }
  ];
  const record = buildEvidenceRecord({
    phase: args.phase,
    slice: args.slice,
    status,
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
    const relative = publishRecord(record);
    printJson({ ok: true, path: relative, record });
    return;
  }
  printJson({ ok: true, record });
}

function commandProve(args) {
  const result = provePhaseZero({
    phase: args.phase,
    slice: args.slice,
    write: args.write,
    root: REPO_ROOT
  });
  if (!result.ok) {
    printJson({
      ok: false,
      code: result.code,
      gateId: result.gateId || null,
      failureKind: result.failureKind || null,
      outputDigest: result.outputDigest || null
    });
    process.exit(1);
  }
  printJson({
    ok: true,
    phase: result.phase,
    slice: result.slice,
    status: result.status,
    path: result.path || null,
    recordDigest: result.recordDigest || result.record?.recordDigest,
    sourceCommit: result.sourceCommit || result.record?.source?.headCommit,
    manifestDigest: result.manifestDigest,
    gateIds: result.gateIds
  });
}

function commandQualify(args) {
  if (!args.phase || !args.host) usage();
  if (!["codex", "claude-code"].includes(args.host)) usage();
  const gaps = [];
  const which = process.platform === "win32" ? "where" : "which";
  const probe = args.host === "claude-code"
    ? (process.platform === "win32" ? "claude.exe" : "claude")
    : (process.platform === "win32" ? "codex.exe" : "codex");
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
        gateId: `live-${args.host}`,
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
    evidenceSystemQualification: false,
    provisionalSupportingRecord: false,
    releaseQualification: false,
    qualification: {
      deterministic: "not_run",
      installedHost: "not_run",
      provider: "not_run",
      release: "not_run"
    }
  });
  if (args.write) {
    const relative = publishRecord(record);
    printJson({
      ok: false,
      qualified: false,
      path: relative,
      residualGaps: gaps.length ? gaps : ["Live qualification was not executed."],
      record
    });
    process.exitCode = 1;
    return;
  }
  printJson({
    ok: false,
    qualified: false,
    residualGaps: gaps.length ? gaps : ["Live qualification was not executed."],
    record
  });
  process.exitCode = 1;
}

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "prove") {
  commandProve(parseProveArgs(rawArgs.slice(1)));
} else {
  const args = parseArgs(rawArgs);
  if (args.help || !args._.length) usage(args.help ? 0 : 2);
  const command = args._[0];
  if (command === "status") commandStatus(args);
  else if (command === "verify") commandVerify(args);
  else if (command === "capture") commandCapture(args);
  else if (command === "qualify") commandQualify(args);
  else usage();
}
