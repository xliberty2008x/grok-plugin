import assert from "node:assert/strict";
import test from "node:test";

import {
  SETUP_COMMAND_IDENTITY_INTERVAL_MS,
  SETUP_COMMAND_IDENTITY_TIMEOUT_MS,
  captureSetupCommandIdentityWithPolling,
  decideSetupScanObservationDisposition,
  evaluateSetupCommandIdentityObservation,
  setupCleanupRequiresObservation,
  unownedSetupCommandGroupGone
} from "../scripts/lib/installed-worker-mcp-setup-boundary.mjs";

const PID = 4242;
const COMMAND_PATH = "/private/runtime/node";
const COMMAND_TEXT = `${COMMAND_PATH} /plugin/grok-codex.mjs setup --json`;

test("setup command identity defaults stay aligned with provider birth-token polling", () => {
  assert.equal(SETUP_COMMAND_IDENTITY_TIMEOUT_MS, 750);
  assert.equal(SETUP_COMMAND_IDENTITY_INTERVAL_MS, 25);
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

test("only an explicit ready false setup skips observation before contract rejection", () => {
  assert.equal(setupCleanupRequiresObservation({ ready: false }), false);
  assert.equal(setupCleanupRequiresObservation({ ready: true }), true);
  assert.equal(setupCleanupRequiresObservation({}), true);
  assert.equal(setupCleanupRequiresObservation(null), true);
  assert.equal(setupCleanupRequiresObservation([]), true);
});
