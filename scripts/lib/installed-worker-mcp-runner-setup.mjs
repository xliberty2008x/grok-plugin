// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { fail, failSetupScan, hasExactKeys, MAX_COMMAND_OUTPUT_BYTES, QualificationError, runBounded, safeParseJson, sameJson, STATE_POLL_MS } from "./installed-worker-mcp-runner-core.mjs";
import { canonicalTimestamp } from "./installed-worker-mcp-runner-observation.mjs";
import { boundedSetupScanDiagnosticCode, captureSetupCommandIdentityWithPolling, decideSetupScanObservationDisposition, SETUP_COMMAND_IDENTITY_INTERVAL_MS, SETUP_COMMAND_IDENTITY_TIMEOUT_MS, unownedSetupCommandGroupGone } from "./installed-worker-mcp-setup-boundary.mjs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SETUP_BOUNDARY_DIAGNOSTIC_STACK_LIMIT = 64 * 1024;
const SETUP_BOUNDARY_DIAGNOSTIC_FRAME =
  /^\s*at\s+(?:[^\r\n(]*\()?(?:[^\r\n)]*[\\/])?(?:installed-worker-mcp-runner-setup|test-installed-worker-mcp)\.mjs:([1-9]\d{0,8}):[1-9]\d{0,8}\)?\s*$/mu;

export function setupGuardDirectories(fixtureRoot, env) {
  const result = runBounded("git", ["rev-parse", "--git-common-dir"], {
    cwd: fixtureRoot,
    env,
    requireSilentStderr: false,
    code: "E_SETUP"
  });
  const reported = String(result.stdout || "").trim();
  if (!reported) fail("E_SETUP");
  let commonDirectory;
  try {
    commonDirectory = fs.realpathSync(
      path.isAbsolute(reported)
        ? reported
        : path.resolve(fixtureRoot, reported)
    );
  } catch {
    fail("E_SETUP");
  }
  const guardRoot = path.join(
    os.tmpdir(),
    `grok-companion-guards-${
      typeof process.getuid === "function" ? process.getuid() : "user"
    }`
  );
  const digest = (value) => crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
  return [...new Set([
    path.join(guardRoot, digest(commonDirectory)),
    path.join(guardRoot, digest(fs.realpathSync(fixtureRoot)))
  ])];
}

export function createSetupBoundary({
  fixtureRoot,
  pluginData,
  env,
  threadId,
  processControl,
  guard
}) {
  const guardDirectories = setupGuardDirectories(fixtureRoot, env);
  for (const directory of guardDirectories) {
    try {
      if (fs.readdirSync(directory).length !== 0) fail("E_CLEANUP");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof QualificationError) throw error;
        fail("E_CLEANUP");
      }
    }
  }
  return {
    fixtureRoot: fs.realpathSync(fixtureRoot),
    pluginData: fs.realpathSync(pluginData),
    env,
    threadId,
    processControl,
    guard,
    guardDirectories,
    commandPids: new Set(),
    identities: new Map(),
    guardRecords: new Map(),
    observedProvider: false,
    observedGuard: false,
    scanFailed: false,
    child: null,
    commandIdentity: null,
    commandObservationIdentity: null,
    commandPath: null,
    childExited: false,
    cleaned: false
  };
}

export function validateSetupGuard(boundary, marker, record) {
  const expectedOwner = crypto
    .createHash("sha256")
    .update(boundary.threadId)
    .digest("hex");
  if (
    !hasExactKeys(record, new Set([
      "schemaVersion",
      "marker",
      "owner",
      "identityKind",
      "providerProcess",
      "createdAt"
    ]))
    || record.schemaVersion !== 1
    || record.marker !== marker
    || record.owner !== expectedOwner
    || record.identityKind !== "provider"
    || !hasExactKeys(
      record.providerProcess,
      new Set(["pid", "startToken", "processGroupId"])
    )
    || !canonicalTimestamp(record.createdAt)
  ) {
    failSetupScan("guard-shape");
  }
  try {
    boundary.processControl.assertCompleteDetachedOwnedIdentity(
      record.providerProcess
    );
  } catch {
    failSetupScan("guard-identity-shape");
  }
  let verifiedMatch = false;
  try {
    verifiedMatch = boundary.processControl.identityMatches(
      record.providerProcess,
      marker,
      "provider"
    );
  } catch {
    failSetupScan("guard-identity-match-probe");
  }
  if (verifiedMatch) return;
  let firstProcessGroupGone = false;
  let secondProcessGroupGone = false;
  try {
    firstProcessGroupGone = boundary.processControl.processGroupGone(
      record.providerProcess
    );
    secondProcessGroupGone = boundary.processControl.processGroupGone(
      record.providerProcess
    );
  } catch {
    failSetupScan("guard-identity-mismatch-gone-proof");
  }
  if (decideSetupScanObservationDisposition({
    verifiedMatch,
    firstProcessGroupGone,
    secondProcessGroupGone
  }) !== "ignore-stale") {
    failSetupScan("guard-identity-mismatch-live-or-ambiguous");
  }
}

export function setupMarkerFromCommand(boundary, command) {
  if (
    typeof command !== "string"
    || !command.includes(boundary.fixtureRoot)
    || !command.includes(boundary.pluginData)
  ) {
    return null;
  }
  const matches = command.matchAll(/(?:^|[^a-zA-Z0-9._-])(setup-(\d+)-[0-9a-f]{12})(?=$|[^a-zA-Z0-9._-])/g);
  const markers = [...matches]
    .filter((match) => boundary.commandPids.has(Number(match[2])))
    .map((match) => match[1]);
  return new Set(markers).size === 1 ? markers[0] : null;
}

export function scanSetupBoundary(boundary) {
  const activeGuardMarkers = new Set();
  for (const directory of boundary.guardDirectories) {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      failSetupScan("guard-directory-read");
    }
    for (const name of names) {
      const match = name.match(/^setup-(\d+)-([0-9a-f]{12})\.json$/);
      if (!match || !boundary.commandPids.has(Number(match[1]))) continue;
      const marker = name.slice(0, -5);
      let record;
      try {
        record = boundary.guard.loadProviderGuard(
          boundary.fixtureRoot,
          marker
        );
      } catch {
        failSetupScan("guard-load");
      }
      // The provider may remove its exact guard between readdir and load.
      // That observation is not evidence, but it is also not ambiguous live
      // state; successful setup still has to produce another validated guard
      // observation before cleanup can pass.
      if (!record) continue;
      try {
        validateSetupGuard(boundary, marker, record);
      } catch (error) {
        if (boundedSetupScanDiagnosticCode(
          error?.diagnostic?.setupScanCode
        )) {
          throw error;
        }
        failSetupScan("guard-validation");
      }
      const previous = boundary.guardRecords.get(marker);
      if (previous && !sameJson(previous, record)) {
        failSetupScan("guard-record-drift");
      }
      const priorIdentity = boundary.identities.get(marker);
      if (
        priorIdentity
        && !sameJson(priorIdentity, record.providerProcess)
      ) {
        failSetupScan("guard-identity-drift");
      }
      boundary.guardRecords.set(marker, structuredClone(record));
      boundary.identities.set(
        marker,
        structuredClone(record.providerProcess)
      );
      boundary.observedGuard = true;
      boundary.observedProvider = true;
      activeGuardMarkers.add(marker);
    }
  }

  const listed = boundary.processControl.runSystemPs([
    "-axo",
    "pid=,command="
  ]);
  if (
    listed?.status !== 0
    || listed?.signal
    || listed?.error
    || Buffer.byteLength(String(listed.stdout || ""), "utf8")
      > MAX_COMMAND_OUTPUT_BYTES
  ) {
    failSetupScan("process-list");
  }
  const liveMarkers = new Set();
  for (const line of String(listed.stdout || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2].trim();
    const marker = setupMarkerFromCommand(boundary, command);
    if (!marker) continue;
    const startToken = boundary.processControl.processStartToken(pid);
    if (!startToken) {
      const incompleteIdentity = {
        pid,
        startToken: null,
        processGroupId: pid
      };
      let firstProcessGroupGone = false;
      let secondProcessGroupGone = false;
      try {
        firstProcessGroupGone = boundary.processControl.processGroupGone(
          incompleteIdentity
        );
        secondProcessGroupGone = boundary.processControl.processGroupGone(
          incompleteIdentity
        );
      } catch {
        failSetupScan("leader-token-gone-proof");
      }
      if (decideSetupScanObservationDisposition({
        verifiedMatch: false,
        firstProcessGroupGone,
        secondProcessGroupGone
      }) === "ignore-stale") {
        continue;
      }
      failSetupScan("leader-token-live-or-ambiguous");
    }
    const identity = { pid, startToken, processGroupId: pid };
    try {
      boundary.processControl.assertCompleteDetachedOwnedIdentity(identity);
    } catch {
      failSetupScan("identity-shape");
    }
    let verifiedMatch = false;
    try {
      verifiedMatch = boundary.processControl.identityMatches(
        identity,
        marker,
        "provider"
      );
    } catch {
      failSetupScan("identity-match-probe");
    }
    if (!verifiedMatch) {
      let firstProcessGroupGone = false;
      let secondProcessGroupGone = false;
      try {
        firstProcessGroupGone = boundary.processControl.processGroupGone(
          identity
        );
        secondProcessGroupGone = boundary.processControl.processGroupGone(
          identity
        );
      } catch {
        failSetupScan("identity-mismatch-gone-proof");
      }
      if (decideSetupScanObservationDisposition({
        verifiedMatch,
        firstProcessGroupGone,
        secondProcessGroupGone
      }) === "ignore-stale") {
        continue;
      }
      failSetupScan("identity-mismatch-live-or-ambiguous");
    }
    const previous = boundary.identities.get(marker);
    if (previous && !sameJson(previous, identity)) {
      failSetupScan("process-identity-drift");
    }
    boundary.identities.set(marker, identity);
    boundary.observedProvider = true;
    liveMarkers.add(marker);
  }
  return { activeGuardMarkers, liveMarkers };
}

export async function stopSetupCommand(boundary) {
  const child = boundary?.child;
  const identity = boundary?.commandIdentity;
  if (!child) return true;
  if (!identity) {
    if (boundary.commandObservationIdentity) {
      return unownedSetupCommandGroupGone({
        identity: boundary.commandObservationIdentity,
        processGroupGone: boundary.processControl.processGroupGone
      });
    }
    return boundary.childExited === true
      && (child.exitCode != null || child.signalCode != null);
  }
  if (boundary.processControl.processGroupGone(identity)) return true;
  const commandStillOwned = () => (
    boundary.processControl.processStartToken(identity.pid)
      === identity.startToken
    && boundary.processControl
      .processCommand(identity.pid)
      .includes(boundary.commandPath)
  );
  if (!commandStillOwned()) return false;
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", done);
    timer = setTimeout(() => {
      child.removeListener("close", done);
      resolve(false);
    }, timeoutMs);
  });
  try { process.kill(-identity.processGroupId, "SIGTERM"); } catch {}
  if (!await waitForExit(1_000)) {
    if (!commandStillOwned()) return false;
    try { process.kill(-identity.processGroupId, "SIGKILL"); } catch {}
    await waitForExit(1_000);
  }
  boundary.childExited = child.exitCode != null || child.signalCode != null;
  return boundary.processControl.processGroupGone(identity);
}

export async function cleanupSetupBoundary(boundary, {
  terminate = false,
  requireObservation = false
} = {}) {
  if (!boundary) return true;
  let clean = true;
  if (terminate && !await stopSetupCommand(boundary)) clean = false;
  for (let pass = 0; pass < 4; pass += 1) {
    try {
      scanSetupBoundary(boundary);
    } catch {
      clean = false;
      break;
    }
    for (const [marker, identity] of boundary.identities) {
      try {
        if (
          terminate
          && !boundary.processControl.processGroupGone(identity)
        ) {
          await boundary.processControl.terminateOwnedProcess(
            identity,
            marker,
            "provider"
          );
        }
      } catch {
        clean = false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  for (const [marker, record] of boundary.guardRecords) {
    const identity = boundary.identities.get(marker);
    try {
      if (
        !identity
        || !boundary.processControl.processGroupGone(identity)
      ) {
        clean = false;
        continue;
      }
      const current = boundary.guard.loadProviderGuard(
        boundary.fixtureRoot,
        marker
      );
      if (current) {
        if (!sameJson(current, record)) {
          clean = false;
          continue;
        }
        boundary.guard.unregisterProviderGuard(
          boundary.fixtureRoot,
          marker,
          record,
          boundary.env
        );
      }
      if (
        boundary.guard.loadProviderGuard(boundary.fixtureRoot, marker)
          !== null
      ) {
        clean = false;
      }
    } catch {
      clean = false;
    }
  }
  let finalScan = null;
  try {
    finalScan = scanSetupBoundary(boundary);
  } catch {
    clean = false;
  }
  if (
    finalScan?.activeGuardMarkers.size
    || finalScan?.liveMarkers.size
    || [...boundary.identities.values()].some(
      (identity) => !boundary.processControl.processGroupGone(identity)
    )
    || (
      boundary.commandIdentity
      && !boundary.processControl.processGroupGone(boundary.commandIdentity)
    )
    || (boundary.child && !boundary.commandIdentity && (
      boundary.commandObservationIdentity
        ? !unownedSetupCommandGroupGone({
            identity: boundary.commandObservationIdentity,
            processGroupGone: boundary.processControl.processGroupGone
          })
        : boundary.childExited !== true
    ))
    || (requireObservation && (
      !boundary.observedProvider
      || !boundary.observedGuard
    ))
  ) {
    clean = false;
  }
  boundary.cleaned = clean;
  return clean;
}

export function setupBoundaryDiagnosticSourceLine(error = null) {
  let stack;
  try {
    stack = error?.stack;
  } catch {
    return null;
  }
  if (
    typeof stack !== "string"
    || stack.length > SETUP_BOUNDARY_DIAGNOSTIC_STACK_LIMIT
  ) {
    return null;
  }
  const match = stack.match(SETUP_BOUNDARY_DIAGNOSTIC_FRAME);
  return match ? Number(match[1]) : null;
}

export function reportSetupBoundaryDiagnostic(phase, error = null) {
  const setupScanCode = boundedSetupScanDiagnosticCode(
    error?.diagnostic?.setupScanCode
  );
  process.stderr.write(
    `Installed Worker MCP setup-boundary diagnostic ${JSON.stringify({
      schemaVersion: 2,
      phase,
      setupScanCode,
      sourceLine: setupBoundaryDiagnosticSourceLine(error)
    })}\n`
  );
}

export async function runSetupJson(command, args, {
  cwd,
  env,
  timeoutMs,
  boundary,
  runner
}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let abortCode = null;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    boundary.child = child;
    boundary.commandPath = path.resolve(command);
    let commandCapture = Promise.resolve({ status: "invalid-pid" });
    const abort = (code) => {
      abortCode ||= code;
      const identity = boundary.commandIdentity;
      try {
        if (
          identity
          && boundary.processControl.processStartToken(identity.pid)
            === identity.startToken
          && boundary.processControl
            .processCommand(identity.pid)
            .includes(boundary.commandPath)
        ) {
          process.kill(-identity.processGroupId, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
    };
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      boundary.commandPids.add(child.pid);
      boundary.commandObservationIdentity = Object.freeze({
        pid: child.pid,
        startToken: null,
        processGroupId: child.pid
      });
      commandCapture = captureSetupCommandIdentityWithPolling({
        pid: child.pid,
        commandPath: boundary.commandPath,
        readStartToken: boundary.processControl.processStartToken,
        readCommand: boundary.processControl.processCommand,
        processGroupGone: boundary.processControl.processGroupGone,
        assertOwnedIdentity:
          boundary.processControl.assertCompleteDetachedOwnedIdentity,
        onOwned: (identity) => {
          boundary.commandIdentity = structuredClone(identity);
        },
        timeoutMs: SETUP_COMMAND_IDENTITY_TIMEOUT_MS,
        intervalMs: SETUP_COMMAND_IDENTITY_INTERVAL_MS
      }).catch(() => ({ status: "incomplete-live" }));
      commandCapture.then((outcome) => {
        if (outcome.status === "incomplete-live") {
          reportSetupBoundaryDiagnostic("command-identity-incomplete");
          abort("E_CLEANUP");
        }
        else if (outcome.status === "invalid-pid") abort("E_SETUP");
      });
    } else {
      abortCode = "E_SETUP";
    }
    const collect = (kind, chunk) => {
      if (kind === "stdout") stdout += String(chunk);
      else stderr += String(chunk);
      if (
        Buffer.byteLength(stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES
        || Buffer.byteLength(stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES
      ) {
        abort("E_SETUP");
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", () => abort("E_SETUP"));
    const poll = setInterval(() => {
      if (runner.interrupted) abort("E_INTERRUPTED");
      try {
        scanSetupBoundary(boundary);
      } catch (error) {
        boundary.scanFailed = true;
        reportSetupBoundaryDiagnostic("active-scan", error);
        abort("E_CLEANUP");
      }
    }, 25);
    const timeout = setTimeout(() => abort("E_SETUP"), timeoutMs);
    const hardTimeout = setTimeout(() => {
      if (settled) return;
      try {
        if (
          boundary.commandIdentity
          && boundary.processControl.processStartToken(
            boundary.commandIdentity.pid
          ) === boundary.commandIdentity.startToken
        ) {
          process.kill(
            -boundary.commandIdentity.processGroupId,
            "SIGKILL"
          );
        } else {
          child.kill("SIGKILL");
        }
      } catch {}
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      reject(new QualificationError(abortCode || "E_SETUP"));
    }, timeoutMs + 2_000);
    child.on("close", (code, signal) => {
      void (async () => {
        const commandCaptureOutcome = await commandCapture;
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        clearTimeout(hardTimeout);
        boundary.childExited = true;
        if (commandCaptureOutcome.status === "incomplete-live") {
          abortCode ||= "E_CLEANUP";
        } else if (commandCaptureOutcome.status === "invalid-pid") {
          abortCode ||= "E_SETUP";
        }
        try {
          scanSetupBoundary(boundary);
        } catch (error) {
          boundary.scanFailed = true;
          reportSetupBoundaryDiagnostic("final-scan", error);
          abortCode ||= "E_CLEANUP";
        }
        if (
          abortCode
          || code !== 0
          || signal
          || String(stderr).trim() !== ""
        ) {
          reject(new QualificationError(abortCode || "E_SETUP"));
          return;
        }
        try {
          resolve(safeParseJson(stdout, "E_SETUP"));
        } catch (error) {
          reject(error);
        }
      })();
    });
  });
}
