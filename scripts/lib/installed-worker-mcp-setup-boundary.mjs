/**
 * Fail-closed decision helpers for the installed Worker MCP setup boundary.
 * Keep process identity and cleanup decisions pure so behavioral tests cover
 * birth-token capture and gone-vs-live races without invoking live providers.
 */

export const SETUP_COMMAND_IDENTITY_TIMEOUT_MS = 750;
export const SETUP_COMMAND_IDENTITY_INTERVAL_MS = 25;

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
