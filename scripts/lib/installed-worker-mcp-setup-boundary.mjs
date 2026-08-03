/**
 * Fail-closed decision helpers for the installed Worker MCP setup boundary.
 * Keep process identity and cleanup decisions pure so behavioral tests cover
 * birth-token capture and gone-vs-live races without invoking live providers.
 */

export const SETUP_COMMAND_IDENTITY_TIMEOUT_MS = 750;
export const SETUP_COMMAND_IDENTITY_INTERVAL_MS = 25;
export const SETUP_GUARD_TRANSITION_TIMEOUT_MS = 5_000;
export const SETUP_GUARD_GONE_INTERVAL_MS = 25;
export const SETUP_SCAN_DIAGNOSTIC_CODES = Object.freeze([
  "guard-directory-read",
  "guard-load",
  "guard-validation",
  "guard-shape",
  "guard-identity-shape",
  "guard-identity-match-probe",
  "guard-identity-mismatch-gone-proof",
  "guard-identity-mismatch-live-or-ambiguous",
  "guard-record-drift",
  "guard-identity-drift",
  "process-list",
  "leader-token-gone-proof",
  "leader-token-live-or-ambiguous",
  "identity-shape",
  "identity-match-probe",
  "identity-mismatch-gone-proof",
  "identity-mismatch-live-or-ambiguous",
  "process-identity-drift"
]);
const SETUP_SCAN_DIAGNOSTIC_CODE_SET =
  new Set(SETUP_SCAN_DIAGNOSTIC_CODES);

/**
 * Project only a fixed, non-sensitive setup-scan failure class. Process
 * identities, commands, paths, and provider output never cross this boundary.
 */
export function boundedSetupScanDiagnosticCode(value) {
  return typeof value === "string"
    && SETUP_SCAN_DIAGNOSTIC_CODE_SET.has(value)
    ? value
    : null;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonemptyTrimmedString(value) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value;
}

/**
 * Evaluate one setup-command identity observation.
 * A missing start token or command mismatch is incomplete and never owned.
 */
export function evaluateSetupCommandIdentityObservation({
  pid,
  startToken,
  commandText,
  commandPath
} = {}) {
  if (!isPositiveSafeInteger(pid)) {
    return Object.freeze({ status: "invalid-pid" });
  }
  if (!isNonemptyTrimmedString(startToken)) {
    return Object.freeze({ status: "incomplete" });
  }
  if (
    typeof commandText !== "string"
    || !isNonemptyTrimmedString(commandPath)
    || !commandText.includes(commandPath)
    || !commandText.includes("setup")
    || !commandText.includes("--json")
  ) {
    return Object.freeze({ status: "command-mismatch" });
  }
  return Object.freeze({
    status: "owned",
    identity: Object.freeze({
      pid,
      startToken,
      processGroupId: pid
    })
  });
}

/**
 * Disposition for a setup-boundary scan observation that may race process exit.
 *
 * - accept: live identity verified
 * - ignore-stale: exact process group proven gone twice
 * - fail-closed: live or ambiguous (never treat as owned/clean)
 *
 * A stale guard/ps observation may be ignored only after a second exact
 * process-group-gone proof.
 */
export function decideSetupScanObservationDisposition({
  verifiedMatch,
  firstProcessGroupGone,
  secondProcessGroupGone
} = {}) {
  if (verifiedMatch === true) return "accept";
  if (
    firstProcessGroupGone === true
    && secondProcessGroupGone === true
  ) {
    return "ignore-stale";
  }
  return "fail-closed";
}

function frozenGuardTransitionResult(status, transition = null, reason = null) {
  return Object.freeze({
    status,
    transition: transition ? Object.freeze({ ...transition }) : null,
    reason
  });
}

/**
 * Advance one exact setup-guard teardown transition.
 *
 * The transition is observation only. It never grants ownership or signal
 * authority. A mismatched identity becomes stale only after two group-gone
 * observations from distinct scan epochs at least 25ms apart. Any live group
 * observation resets that proof. Drift, reappearance, or failure to close
 * strictly before the fixed five-second deadline fails closed. An observation
 * whose process-group proof completes at the deadline is already too late,
 * even if the scan itself began earlier. Scan epochs must increase strictly,
 * and a later scan cannot begin before the prior proof completed.
 */
export function advanceSetupGuardTransition({
  transition = null,
  scanEpoch,
  observedAt,
  proofCompletedAt = observedAt,
  guardPresent,
  exactIdentityMatch = false,
  processGroupGone = false,
  sameRecord = true,
  sameIdentity = true,
  correlatedMarkerIdentity = true
} = {}) {
  if (
    !Number.isSafeInteger(scanEpoch)
    || scanEpoch <= 0
    || !Number.isFinite(observedAt)
    || observedAt < 0
    || !Number.isFinite(proofCompletedAt)
    || proofCompletedAt < observedAt
    || typeof guardPresent !== "boolean"
    || typeof exactIdentityMatch !== "boolean"
    || typeof processGroupGone !== "boolean"
  ) {
    return frozenGuardTransitionResult("fail-closed", null, "invalid");
  }
  if (!sameRecord || !sameIdentity || !correlatedMarkerIdentity) {
    return frozenGuardTransitionResult("fail-closed", null, "drift");
  }
  if (!transition && exactIdentityMatch) {
    return frozenGuardTransitionResult("verified");
  }

  const continuing = transition !== null;
  const current = continuing ? { ...transition } : {
    startedAt: observedAt,
    deadlineAt: observedAt + SETUP_GUARD_TRANSITION_TIMEOUT_MS,
    lastScanEpoch: scanEpoch,
    lastObservedAt: observedAt,
    lastProofCompletedAt: proofCompletedAt,
    lastGoneAt: null,
    lastGoneEpoch: null,
    goneStreak: 0,
    guardDisappeared: !guardPresent
  };
  if (
    !Number.isFinite(current.startedAt)
    || !Number.isFinite(current.deadlineAt)
    || observedAt < current.startedAt
    || current.deadlineAt - current.startedAt
      !== SETUP_GUARD_TRANSITION_TIMEOUT_MS
    || !Number.isSafeInteger(current.lastScanEpoch)
    || current.lastScanEpoch <= 0
    || !Number.isFinite(current.lastObservedAt)
    || current.lastObservedAt < current.startedAt
    || !Number.isFinite(current.lastProofCompletedAt)
    || current.lastProofCompletedAt < current.lastObservedAt
    || !Number.isSafeInteger(current.goneStreak)
    || current.goneStreak < 0
    || typeof current.guardDisappeared !== "boolean"
    || (
      current.lastGoneAt === null
      && (
        current.lastGoneEpoch !== null
        || current.goneStreak !== 0
      )
    )
    || (
      current.lastGoneAt !== null
      && (
        !Number.isFinite(current.lastGoneAt)
        || proofCompletedAt < current.lastGoneAt
        || !Number.isSafeInteger(current.lastGoneEpoch)
        || current.lastGoneEpoch <= 0
        || current.goneStreak < 1
      )
    )
  ) {
    return frozenGuardTransitionResult("fail-closed", null, "invalid");
  }
  if (
    continuing
    && (
      scanEpoch <= current.lastScanEpoch
      || observedAt < current.lastObservedAt
      || observedAt < current.lastProofCompletedAt
      || proofCompletedAt < current.lastProofCompletedAt
    )
  ) {
    return frozenGuardTransitionResult("fail-closed", null, "invalid");
  }
  if (
    exactIdentityMatch
    || (current.guardDisappeared && guardPresent)
  ) {
    return frozenGuardTransitionResult("fail-closed", null, "reappearance");
  }
  if (!guardPresent) current.guardDisappeared = true;

  current.lastScanEpoch = scanEpoch;
  current.lastObservedAt = observedAt;
  current.lastProofCompletedAt = proofCompletedAt;

  if (proofCompletedAt >= current.deadlineAt) {
    return frozenGuardTransitionResult("fail-closed", null, "timeout");
  }

  if (!processGroupGone) {
    current.goneStreak = 0;
    current.lastGoneAt = null;
    current.lastGoneEpoch = null;
  } else if (current.lastGoneAt === null) {
    current.goneStreak = 1;
    current.lastGoneAt = proofCompletedAt;
    current.lastGoneEpoch = scanEpoch;
  } else if (
    current.lastGoneEpoch !== scanEpoch
    && proofCompletedAt - current.lastGoneAt
      >= SETUP_GUARD_GONE_INTERVAL_MS
  ) {
    current.goneStreak += 1;
    current.lastGoneAt = proofCompletedAt;
    current.lastGoneEpoch = scanEpoch;
  }

  if (current.goneStreak >= 2) {
    return frozenGuardTransitionResult(
      guardPresent ? "stale-present" : "closed"
    );
  }
  return frozenGuardTransitionResult("pending", current);
}

/**
 * An uncaptured setup command PID is observation only, never signal authority.
 * Cleanup may proceed only after the exact candidate process group is proven
 * gone twice. Leader exit state alone is deliberately irrelevant because a
 * same-group descendant may still be alive.
 */
export function unownedSetupCommandGroupGone({
  identity,
  processGroupGone
} = {}) {
  if (
    !isPositiveSafeInteger(identity?.pid)
    || identity.startToken !== null
    || identity.processGroupId !== identity.pid
    || typeof processGroupGone !== "function"
  ) {
    return false;
  }
  let firstProcessGroupGone = false;
  let secondProcessGroupGone = false;
  try {
    firstProcessGroupGone = processGroupGone(identity) === true;
    secondProcessGroupGone = processGroupGone(identity) === true;
  } catch {
    return false;
  }
  return decideSetupScanObservationDisposition({
    verifiedMatch: false,
    firstProcessGroupGone,
    secondProcessGroupGone
  }) === "ignore-stale";
}

/**
 * Capture the outer setup command identity with bounded birth-token polling.
 * Semantics match production captureSpawnIdentity (750ms/25ms defaults).
 * Missing identity is never recorded as owned.
 *
 * Returns:
 * - owned: complete detached identity recorded via onOwned
 * - gone-unrecorded: process group proven gone twice before ownership
 * - incomplete-live: deadline elapsed while live/ambiguous without ownership
 * - invalid-pid: spawn did not expose a usable PID
 */
export async function captureSetupCommandIdentityWithPolling({
  pid,
  commandPath,
  readStartToken,
  readCommand,
  processGroupGone,
  assertOwnedIdentity = null,
  onOwned = null,
  timeoutMs = SETUP_COMMAND_IDENTITY_TIMEOUT_MS,
  intervalMs = SETUP_COMMAND_IDENTITY_INTERVAL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!isPositiveSafeInteger(pid)) {
    return Object.freeze({ status: "invalid-pid" });
  }
  if (
    typeof readStartToken !== "function"
    || typeof readCommand !== "function"
    || typeof processGroupGone !== "function"
  ) {
    return Object.freeze({ status: "incomplete-live" });
  }

  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  const pollMs = Math.max(1, Number(intervalMs) || 1);

  while (true) {
    const startToken = readStartToken(pid);
    const commandText = readCommand(pid);
    const evaluation = evaluateSetupCommandIdentityObservation({
      pid,
      startToken,
      commandText,
      commandPath
    });

    if (evaluation.status === "owned") {
      let owned = true;
      if (typeof assertOwnedIdentity === "function") {
        try {
          assertOwnedIdentity(evaluation.identity);
        } catch {
          owned = false;
        }
      }
      if (owned) {
        if (typeof onOwned === "function") onOwned(evaluation.identity);
        return Object.freeze({
          status: "owned",
          identity: evaluation.identity
        });
      }
    }

    const incompleteIdentity = Object.freeze({
      pid,
      startToken: null,
      processGroupId: pid
    });
    const firstGone = processGroupGone(incompleteIdentity) === true;
    const secondGone = processGroupGone(incompleteIdentity) === true;
    if (
      decideSetupScanObservationDisposition({
        verifiedMatch: false,
        firstProcessGroupGone: firstGone,
        secondProcessGroupGone: secondGone
      }) === "ignore-stale"
    ) {
      return Object.freeze({ status: "gone-unrecorded" });
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  return Object.freeze({ status: "incomplete-live" });
}

/**
 * Successful ready:true setup still requires provider and guard observation.
 * Parsed ready:false setup cleans without mandatory observation, then the
 * existing setup contract rejects it as E_SETUP.
 * Any non-false ready value fails closed and requires observation.
 */
export function setupCleanupRequiresObservation(setupResult) {
  return !(
    setupResult
    && typeof setupResult === "object"
    && !Array.isArray(setupResult)
    && setupResult.ready === false
  );
}
