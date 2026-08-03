import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  SETUP_COMMAND_IDENTITY_INTERVAL_MS,
  SETUP_COMMAND_IDENTITY_TIMEOUT_MS,
  SETUP_GUARD_GONE_INTERVAL_MS,
  SETUP_GUARD_TRANSITION_TIMEOUT_MS,
  SETUP_SCAN_DIAGNOSTIC_CODES,
  advanceSetupGuardTransition,
  boundedSetupScanDiagnosticCode,
  captureSetupCommandIdentityWithPolling,
  decideSetupScanObservationDisposition,
  evaluateSetupCommandIdentityObservation,
  setupCleanupRequiresObservation,
  unownedSetupCommandGroupGone
} from "../scripts/lib/installed-worker-mcp-setup-boundary.mjs";
import {
  cleanupSetupBoundary,
  runSetupJson,
  scanSetupBoundary
} from "../scripts/lib/installed-worker-mcp-runner-setup.mjs";

const PID = 4242;
const COMMAND_PATH = "/private/runtime/node";
const COMMAND_TEXT = `${COMMAND_PATH} /plugin/grok-codex.mjs setup --json`;
const MARKER = `setup-${PID}-abcdef123456`;
const THREAD_ID = "setup-boundary-unit-thread";
const FIXTURE_ROOT = "/private/setup-fixture";
const PLUGIN_DATA = "/private/setup-plugin-data";

function setupRecord(identity = {
  pid: PID,
  startToken: "Mon Jul 23 12:00:00 2026",
  processGroupId: PID
}) {
  return {
    schemaVersion: 1,
    marker: MARKER,
    owner: crypto.createHash("sha256").update(THREAD_ID).digest("hex"),
    identityKind: "provider",
    providerProcess: identity,
    createdAt: "2026-07-23T12:00:00.000Z"
  };
}

function createScanHarness(t) {
  const directory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "grok-setup-boundary-test-"
  ));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, `${MARKER}.json`), "guard");
  let clock = 0;
  let record = setupRecord();
  let identityMatch = false;
  let groupGone = false;
  let groupGoneProbe = null;
  let psOutput = "";
  let groupGoneCalls = 0;
  let terminateCalls = 0;
  let unregisterCalls = 0;
  const boundary = {
    fixtureRoot: FIXTURE_ROOT,
    pluginData: PLUGIN_DATA,
    env: {},
    threadId: THREAD_ID,
    processControl: {
      assertCompleteDetachedOwnedIdentity: (identity) => {
        assert.equal(identity.processGroupId, identity.pid);
        assert.equal(typeof identity.startToken, "string");
      },
      identityMatches: () => identityMatch,
      processGroupGone: () => {
        groupGoneCalls += 1;
        return groupGoneProbe ? groupGoneProbe() : groupGone;
      },
      runSystemPs: () => ({
        status: 0,
        signal: null,
        error: null,
        stdout: psOutput
      }),
      processStartToken: (pid) => pid === PID
        ? record?.providerProcess?.startToken || null
        : "different-start-token",
      terminateOwnedProcess: async () => { terminateCalls += 1; }
    },
    guard: {
      loadProviderGuard: () => record ? structuredClone(record) : null,
      unregisterProviderGuard: (_root, marker, expected) => {
        assert.equal(marker, MARKER);
        assert.deepEqual(expected, record);
        unregisterCalls += 1;
        record = null;
      }
    },
    guardDirectories: [directory],
    commandPids: new Set([PID]),
    identities: new Map(),
    guardRecords: new Map(),
    staleGuardRecords: new Map(),
    pendingGuardTransitions: new Map(),
    closedGuardMarkers: new Set(),
    scanEpoch: 0,
    now: () => clock,
    observedProvider: false,
    observedGuard: false,
    scanFailed: false,
    child: null,
    commandIdentity: null,
    commandObservationIdentity: null,
    childExited: true,
    cleaned: false
  };
  return {
    boundary,
    setClock: (value) => { clock = value; },
    setRecord: (value) => { record = value; },
    getRecord: () => record,
    setIdentityMatch: (value) => { identityMatch = value; },
    setGroupGone: (value) => { groupGone = value; },
    setGroupGoneProbe: (value) => { groupGoneProbe = value; },
    setPsOutput: (value) => { psOutput = value; },
    groupGoneCalls: () => groupGoneCalls,
    terminateCalls: () => terminateCalls,
    unregisterCalls: () => unregisterCalls
  };
}

test("setup command identity defaults stay aligned with provider birth-token polling", () => {
  assert.equal(SETUP_COMMAND_IDENTITY_TIMEOUT_MS, 750);
  assert.equal(SETUP_COMMAND_IDENTITY_INTERVAL_MS, 25);
  assert.equal(SETUP_GUARD_TRANSITION_TIMEOUT_MS, 5_000);
  assert.equal(SETUP_GUARD_GONE_INTERVAL_MS, 25);
});

test("setup scan diagnostics expose only fixed non-sensitive classes", () => {
  assert.equal(Object.isFrozen(SETUP_SCAN_DIAGNOSTIC_CODES), true);
  assert.equal(new Set(SETUP_SCAN_DIAGNOSTIC_CODES).size, 18);
  for (const code of SETUP_SCAN_DIAGNOSTIC_CODES) {
    assert.match(code, /^[a-z][a-z-]+$/);
    assert.equal(boundedSetupScanDiagnosticCode(code), code);
  }
  for (const value of [
    null,
    "",
    "unknown",
    "/private/provider/path",
    "pid-1234"
  ]) {
    assert.equal(boundedSetupScanDiagnosticCode(value), null);
  }
});

test("setup command identity polling admits initial-null then exact owned identity", async () => {
  let clock = 0;
  let reads = 0;
  let asserted = null;
  let recorded = null;
  const result = await captureSetupCommandIdentityWithPolling({
    pid: PID,
    commandPath: COMMAND_PATH,
    readStartToken: () => {
      reads += 1;
      return reads === 1 ? null : "Mon Jul 23 12:00:00 2026";
    },
    readCommand: () => COMMAND_TEXT,
    processGroupGone: () => false,
    assertOwnedIdentity: (identity) => { asserted = identity; },
    onOwned: (identity) => { recorded = identity; },
    timeoutMs: 50,
    intervalMs: 25,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });

  const expected = {
    pid: PID,
    startToken: "Mon Jul 23 12:00:00 2026",
    processGroupId: PID
  };
  assert.equal(result.status, "owned");
  assert.deepEqual(result.identity, expected);
  assert.deepEqual(asserted, expected);
  assert.deepEqual(recorded, expected);
  assert.equal(reads, 2);
});

test("setup command capture never treats invalid, mismatched, or live-incomplete state as owned", async () => {
  assert.deepEqual(
    evaluateSetupCommandIdentityObservation({
      pid: PID,
      startToken: "token",
      commandText: `${COMMAND_PATH} /plugin/grok-codex.mjs setup`,
      commandPath: COMMAND_PATH
    }),
    { status: "command-mismatch" }
  );

  const incomplete = await captureSetupCommandIdentityWithPolling({
    pid: PID,
    commandPath: COMMAND_PATH,
    readStartToken: () => null,
    readCommand: () => "",
    processGroupGone: () => false,
    timeoutMs: 0,
    now: () => 0
  });
  assert.deepEqual(incomplete, { status: "incomplete-live" });

  const invalid = await captureSetupCommandIdentityWithPolling({
    pid: 0,
    commandPath: COMMAND_PATH
  });
  assert.deepEqual(invalid, { status: "invalid-pid" });
});

test("setup command capture distinguishes twice-gone stale state from ambiguity", async () => {
  let goneChecks = 0;
  const gone = await captureSetupCommandIdentityWithPolling({
    pid: PID,
    commandPath: COMMAND_PATH,
    readStartToken: () => null,
    readCommand: () => "",
    processGroupGone: () => {
      goneChecks += 1;
      return true;
    },
    timeoutMs: 0,
    now: () => 0
  });
  assert.deepEqual(gone, { status: "gone-unrecorded" });
  assert.equal(goneChecks, 2);

  assert.equal(decideSetupScanObservationDisposition({
    verifiedMatch: false,
    firstProcessGroupGone: true,
    secondProcessGroupGone: true
  }), "ignore-stale");
  for (const [firstProcessGroupGone, secondProcessGroupGone] of [
    [false, false],
    [false, true],
    [true, false]
  ]) {
    assert.equal(decideSetupScanObservationDisposition({
      verifiedMatch: false,
      firstProcessGroupGone,
      secondProcessGroupGone
    }), "fail-closed");
  }
  assert.equal(decideSetupScanObservationDisposition({
    verifiedMatch: true,
    firstProcessGroupGone: false,
    secondProcessGroupGone: false
  }), "accept");
});

test("an incomplete capture cannot clean a live descendant after the leader exits", async () => {
  const observation = {
    pid: PID,
    startToken: null,
    processGroupId: PID
  };
  const capture = await captureSetupCommandIdentityWithPolling({
    pid: PID,
    commandPath: COMMAND_PATH,
    readStartToken: () => null,
    readCommand: () => "",
    processGroupGone: () => false,
    timeoutMs: 0,
    now: () => 0
  });
  assert.deepEqual(capture, { status: "incomplete-live" });

  // The leader's exit is intentionally not an input: a live same-group
  // descendant keeps cleanup unproven.
  assert.equal(unownedSetupCommandGroupGone({
    identity: observation,
    processGroupGone: () => false
  }), false);

  let probes = 0;
  assert.equal(unownedSetupCommandGroupGone({
    identity: observation,
    processGroupGone: () => {
      probes += 1;
      return true;
    }
  }), true);
  assert.equal(probes, 2);
});

test("setup guard transition requires distinct gone scan epochs and never verifies stale state", () => {
  const initial = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: true,
    exactIdentityMatch: false,
    processGroupGone: true
  });
  assert.equal(initial.status, "pending");
  assert.equal(initial.transition.goneStreak, 1);

  const reusedEpoch = advanceSetupGuardTransition({
    transition: initial.transition,
    scanEpoch: 1,
    observedAt: 10,
    guardPresent: true,
    exactIdentityMatch: false,
    processGroupGone: true
  });
  assert.equal(reusedEpoch.status, "fail-closed");
  assert.equal(reusedEpoch.reason, "invalid");

  let outcome = advanceSetupGuardTransition({
    transition: initial.transition,
    scanEpoch: 2,
    observedAt: 24,
    guardPresent: true,
    exactIdentityMatch: false,
    processGroupGone: true
  });
  assert.equal(outcome.status, "pending", "epochs must be 25ms apart");

  outcome = advanceSetupGuardTransition({
    transition: outcome.transition,
    scanEpoch: 3,
    observedAt: 25,
    guardPresent: true,
    exactIdentityMatch: false,
    processGroupGone: true
  });
  assert.equal(outcome.status, "stale-present");
  assert.equal(outcome.transition, null);
});

test("setup guard transition accepts only an exact live match as verification", () => {
  const verified = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: true,
    exactIdentityMatch: true,
    processGroupGone: false
  });
  assert.deepEqual(verified, {
    status: "verified",
    transition: null,
    reason: null
  });

  const neverVerified = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: true,
    exactIdentityMatch: false,
    processGroupGone: false
  });
  assert.equal(neverVerified.status, "pending");
});

test("live setup guard descendants reset gone proof and time out after five seconds", () => {
  let outcome = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: true,
    processGroupGone: true
  });
  outcome = advanceSetupGuardTransition({
    transition: outcome.transition,
    scanEpoch: 2,
    observedAt: 25,
    guardPresent: true,
    processGroupGone: false
  });
  assert.equal(outcome.status, "pending");
  assert.equal(outcome.transition.goneStreak, 0);
  assert.equal(outcome.transition.lastGoneAt, null);

  outcome = advanceSetupGuardTransition({
    transition: outcome.transition,
    scanEpoch: 3,
    observedAt: SETUP_GUARD_TRANSITION_TIMEOUT_MS,
    guardPresent: true,
    processGroupGone: false
  });
  assert.equal(outcome.status, "fail-closed");
  assert.equal(outcome.reason, "timeout");
});

test("setup guard gone proof must finish strictly before its deadline", () => {
  let beforeDeadline = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: false,
    processGroupGone: true
  });
  beforeDeadline = advanceSetupGuardTransition({
    transition: beforeDeadline.transition,
    scanEpoch: 2,
    observedAt: SETUP_GUARD_TRANSITION_TIMEOUT_MS - 1,
    guardPresent: false,
    processGroupGone: true
  });
  assert.equal(beforeDeadline.status, "closed");

  let atDeadline = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: false,
    processGroupGone: true
  });
  atDeadline = advanceSetupGuardTransition({
    transition: atDeadline.transition,
    scanEpoch: 2,
    observedAt: SETUP_GUARD_TRANSITION_TIMEOUT_MS,
    guardPresent: false,
    processGroupGone: true
  });
  assert.equal(atDeadline.status, "fail-closed");
  assert.equal(atDeadline.reason, "timeout");
});

test("scan uses gone-proof completion time when the proof crosses its deadline", (t) => {
  const harness = createScanHarness(t);
  harness.setIdentityMatch(true);
  scanSetupBoundary(harness.boundary);

  harness.setIdentityMatch(false);
  harness.setGroupGone(true);
  harness.setRecord(null);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 1);

  harness.setClock(SETUP_GUARD_TRANSITION_TIMEOUT_MS - 1);
  harness.setGroupGoneProbe(() => {
    harness.setClock(SETUP_GUARD_TRANSITION_TIMEOUT_MS);
    return true;
  });
  assert.throws(
    () => scanSetupBoundary(harness.boundary),
    (error) => error?.diagnostic?.setupScanCode
      === "guard-identity-mismatch-live-or-ambiguous"
  );
  assert.equal(harness.boundary.pendingGuardTransitions.size, 1);
  assert.equal(harness.boundary.staleGuardRecords.size, 0);
  assert.equal(harness.boundary.closedGuardMarkers.has(MARKER), false);
});

test("setup guard transition fails on disappearance reappearance and drift", () => {
  let disappeared = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: false,
    processGroupGone: false
  });
  disappeared = advanceSetupGuardTransition({
    transition: disappeared.transition,
    scanEpoch: 2,
    observedAt: 25,
    guardPresent: true,
    processGroupGone: false
  });
  assert.equal(disappeared.status, "fail-closed");
  assert.equal(disappeared.reason, "reappearance");

  const drifted = advanceSetupGuardTransition({
    scanEpoch: 1,
    observedAt: 0,
    guardPresent: true,
    processGroupGone: false,
    sameRecord: false
  });
  assert.equal(drifted.status, "fail-closed");
  assert.equal(drifted.reason, "drift");
});

test("setup guard transition rejects epoch and observation-time rollback", () => {
  const initial = advanceSetupGuardTransition({
    scanEpoch: 2,
    observedAt: 100,
    proofCompletedAt: 150,
    guardPresent: true,
    processGroupGone: true
  });
  assert.equal(initial.status, "pending");

  for (const scanEpoch of [1, 2]) {
    const rolledBack = advanceSetupGuardTransition({
      transition: initial.transition,
      scanEpoch,
      observedAt: 150,
      proofCompletedAt: 175,
      guardPresent: true,
      processGroupGone: true
    });
    assert.equal(rolledBack.status, "fail-closed");
    assert.equal(rolledBack.reason, "invalid");
  }

  const observationRollback = advanceSetupGuardTransition({
    transition: initial.transition,
    scanEpoch: 3,
    observedAt: 125,
    proofCompletedAt: 175,
    guardPresent: true,
    processGroupGone: true
  });
  assert.equal(observationRollback.status, "fail-closed");
  assert.equal(observationRollback.reason, "invalid");
});

test("never-verified stale setup guard stays cleanup-only and is exact-deleted", async (t) => {
  const harness = createScanHarness(t);
  harness.setGroupGone(true);

  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 1);
  assert.equal(harness.boundary.observedGuard, false);
  assert.equal(harness.boundary.observedProvider, false);
  assert.equal(harness.boundary.guardRecords.size, 0);
  assert.equal(harness.boundary.identities.size, 0);

  harness.setClock(25);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 0);
  assert.equal(harness.boundary.staleGuardRecords.size, 1);
  assert.equal(harness.boundary.guardRecords.size, 0);

  assert.equal(await cleanupSetupBoundary(harness.boundary), true);
  assert.equal(harness.unregisterCalls(), 1);
  assert.equal(harness.terminateCalls(), 0);
  assert.equal(harness.getRecord(), null);
});

test("setup scan drift preserves stale guard evidence and blocks unregister", async (t) => {
  const harness = createScanHarness(t);
  harness.setGroupGone(true);
  scanSetupBoundary(harness.boundary);
  harness.setClock(25);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.staleGuardRecords.size, 1);

  harness.setPsOutput(
    `9999 provider ${FIXTURE_ROOT} ${PLUGIN_DATA} ${MARKER}`
  );
  assert.equal(await cleanupSetupBoundary(harness.boundary), false);
  assert.equal(harness.boundary.scanFailed, true);
  assert.equal(harness.unregisterCalls(), 0);
  assert.notEqual(harness.getRecord(), null);
  assert.equal(harness.boundary.staleGuardRecords.size, 1);
});

test("runSetupJson makes sticky scan failure a single abort and diagnostic", async (t) => {
  const harness = createScanHarness(t);
  harness.setGroupGone(true);
  scanSetupBoundary(harness.boundary);
  harness.setClock(25);
  scanSetupBoundary(harness.boundary);
  const scansBeforeRun = harness.groupGoneCalls();
  const childState = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "grok-setup-sticky-child-"
  ));
  t.after(() => fs.rmSync(childState, { recursive: true, force: true }));
  const readyPath = path.join(childState, "ready");
  const signalsPath = path.join(childState, "signals");
  const providerGroupGone =
    harness.boundary.processControl.processGroupGone;
  harness.boundary.processControl.processGroupGone = (identity) => (
    identity?.pid === PID ? providerGroupGone(identity) : false
  );
  const priorStartToken = harness.boundary.processControl.processStartToken;
  harness.boundary.processControl.processStartToken = (pid) => (
    pid === harness.boundary.child?.pid
      ? null
      : priorStartToken(pid)
  );
  harness.boundary.processControl.processCommand = () => "";
  let failureScanEpoch = null;
  harness.boundary.processControl.runSystemPs = () => {
    const childReady = fs.existsSync(readyPath);
    if (childReady) failureScanEpoch ??= harness.boundary.scanEpoch;
    return {
      status: 0,
      signal: null,
      error: null,
      stdout: childReady
        ? `9999 provider ${FIXTURE_ROOT} ${PLUGIN_DATA} ${MARKER}`
        : ""
    };
  };

  let diagnostics = "";
  const stderrWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    diagnostics += String(chunk);
    return true;
  };
  let child = null;
  try {
    await assert.rejects(
      runSetupJson(process.execPath, [
        "-e",
        [
          "const fs = require('node:fs');",
          "const readyPath = process.argv[1];",
          "const signalsPath = process.argv[2];",
          "process.on('SIGTERM', () => {",
          "  fs.appendFileSync(signalsPath, 'SIGTERM\\n');",
          "});",
          "fs.writeFileSync(readyPath, 'ready');",
          "setInterval(() => {}, 1000);"
        ].join("\n"),
        readyPath,
        signalsPath,
        "--",
        "setup",
        "--json"
      ], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1_000,
        boundary: harness.boundary,
        runner: { interrupted: false }
      }),
      (error) => error?.code === "E_CLEANUP"
    );
  } finally {
    process.stderr.write = stderrWrite;
    child = harness.boundary.child;
    if (
      Number.isSafeInteger(child?.pid)
      && child.pid > 0
      && child.exitCode == null
      && child.signalCode == null
    ) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 1_000))
      ]);
    }
  }

  assert.equal(harness.boundary.scanFailed, true);
  assert.ok(harness.groupGoneCalls() > scansBeforeRun);
  assert.equal(harness.boundary.scanEpoch, failureScanEpoch);
  assert.equal(
    fs.readFileSync(signalsPath, "utf8").trim().split("\n").length,
    1,
    "the child survives the first abort and receives no later signal"
  );
  assert.equal(
    (diagnostics.match(/setup-boundary diagnostic/g) || []).length,
    1,
    "scan failure emits exactly one bounded diagnostic"
  );
  assert.equal((diagnostics.match(/"phase":"active-scan"/g) || []).length, 1);
  assert.equal(
    diagnostics.includes('"phase":"command-identity-incomplete"'),
    false
  );
  assert.equal(diagnostics.includes('"phase":"final-scan"'), false);
  assert.equal(await cleanupSetupBoundary(harness.boundary), false);
  assert.equal(harness.unregisterCalls(), 0);
  assert.notEqual(harness.getRecord(), null);
});

test("verified setup guard tolerates bounded teardown without signalling pending identity", async (t) => {
  const harness = createScanHarness(t);
  harness.setIdentityMatch(true);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.observedGuard, true);
  assert.equal(harness.boundary.observedProvider, true);
  assert.equal(harness.boundary.guardRecords.size, 1);
  assert.equal(harness.boundary.identities.size, 1);

  harness.setIdentityMatch(false);
  harness.setGroupGone(false);
  harness.setClock(25);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 1);

  harness.setGroupGone(true);
  harness.setClock(50);
  scanSetupBoundary(harness.boundary);
  harness.setClock(75);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 0);
  assert.equal(harness.boundary.staleGuardRecords.size, 1);

  assert.equal(await cleanupSetupBoundary(harness.boundary, {
    terminate: true,
    requireObservation: true
  }), true);
  assert.equal(harness.terminateCalls(), 0);
  assert.equal(harness.unregisterCalls(), 1);
});

test("verified guard disappearance uses spaced gone proofs and rejects reappearance", (t) => {
  const harness = createScanHarness(t);
  harness.setIdentityMatch(true);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.observedGuard, true);

  harness.setIdentityMatch(false);
  harness.setGroupGone(true);
  harness.setRecord(null);
  harness.setClock(25);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 1);
  assert.equal(harness.groupGoneCalls(), 1);

  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 1);
  assert.equal(harness.groupGoneCalls(), 2);

  harness.setClock(50);
  scanSetupBoundary(harness.boundary);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 0);
  assert.equal(harness.boundary.closedGuardMarkers.has(MARKER), true);
  assert.equal(harness.groupGoneCalls(), 3);

  harness.setRecord(setupRecord());
  harness.setClock(75);
  assert.throws(
    () => scanSetupBoundary(harness.boundary),
    (error) => error?.diagnostic?.setupScanCode === "guard-identity-drift"
  );
});

test("persistent setup descendant leaves cleanup pending without signal or delete", async (t) => {
  const harness = createScanHarness(t);
  harness.setGroupGone(false);
  scanSetupBoundary(harness.boundary);
  harness.setClock(SETUP_GUARD_TRANSITION_TIMEOUT_MS);

  assert.equal(await cleanupSetupBoundary(harness.boundary, {
    terminate: true
  }), false);
  assert.equal(harness.boundary.pendingGuardTransitions.size, 1);
  assert.equal(harness.terminateCalls(), 0);
  assert.equal(harness.unregisterCalls(), 0);
  assert.notEqual(harness.getRecord(), null);
});

test("pending setup guard fails closed on record drift reappearance and ps identity mismatch", (t) => {
  const psCorrelated = createScanHarness(t);
  psCorrelated.setGroupGone(false);
  psCorrelated.setPsOutput(
    `${PID} provider ${FIXTURE_ROOT} ${PLUGIN_DATA} ${MARKER}`
  );
  assert.doesNotThrow(() => scanSetupBoundary(psCorrelated.boundary));
  assert.equal(psCorrelated.boundary.pendingGuardTransitions.size, 1);

  const recordDrift = createScanHarness(t);
  recordDrift.setGroupGone(false);
  scanSetupBoundary(recordDrift.boundary);
  recordDrift.setClock(25);
  recordDrift.setRecord({
    ...recordDrift.getRecord(),
    createdAt: "2026-07-23T12:00:01.000Z"
  });
  assert.throws(
    () => scanSetupBoundary(recordDrift.boundary),
    (error) => error?.diagnostic?.setupScanCode === "guard-record-drift"
  );

  const reappearance = createScanHarness(t);
  reappearance.setGroupGone(false);
  scanSetupBoundary(reappearance.boundary);
  reappearance.setRecord(null);
  reappearance.setClock(25);
  scanSetupBoundary(reappearance.boundary);
  reappearance.setRecord(setupRecord());
  reappearance.setClock(50);
  assert.throws(
    () => scanSetupBoundary(reappearance.boundary),
    (error) => error?.diagnostic?.setupScanCode === "guard-identity-drift"
  );

  const psMismatch = createScanHarness(t);
  psMismatch.setGroupGone(false);
  psMismatch.setPsOutput(
    `9999 provider ${FIXTURE_ROOT} ${PLUGIN_DATA} ${MARKER}`
  );
  assert.throws(
    () => scanSetupBoundary(psMismatch.boundary),
    (error) => error?.diagnostic?.setupScanCode === "process-identity-drift"
  );
});

test("only an explicit ready false setup skips observation before contract rejection", () => {
  assert.equal(setupCleanupRequiresObservation({ ready: false }), false);
  assert.equal(setupCleanupRequiresObservation({ ready: true }), true);
  assert.equal(setupCleanupRequiresObservation({}), true);
  assert.equal(setupCleanupRequiresObservation(null), true);
  assert.equal(setupCleanupRequiresObservation([]), true);
});
