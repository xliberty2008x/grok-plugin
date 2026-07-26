import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PHASE_THREE_LIVE_GATE_IDS,
  PHASE_THREE_LIVE_RECEIPT_MANIFEST,
  buildPhaseThreeLiveReceipt,
  computePhaseThreeLiveInputDigest,
  computePhaseThreeLiveReceiptDigest,
  phaseThreeLiveReceiptRelativePath,
  validatePhaseThreeCompletionEvidence,
  validatePhaseThreeLiveReceipt,
  validatePhaseThreeTwoWriterEvidence,
  writePhaseThreeLiveReceipt
} from "../scripts/lib/worker-broker-phase3-evidence.mjs";
import {
  publishImmutableEvidenceArtifact
} from "../scripts/lib/worker-broker-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA40 = "a".repeat(40);
const digest = (character) => character.repeat(64);

function commonBindings() {
  return {
    sourceHeadCommit: SHA40,
    sourceHeadTree: "b".repeat(40),
    sourceInventoryDigest: digest("1"),
    sourcePluginInventoryDigest: digest("2"),
    installedPluginInventoryDigest: digest("2"),
    installedEntrypointDigest: digest("3"),
    providerVersion: "0.2.112",
    providerBinaryDigest: digest("4"),
    providerCapabilityDigest: digest("5"),
    providerPinRef: `gpin-${"6".repeat(32)}`,
    providerLaunchBindingDigest: digest("7"),
    providerExecutableIdentityDigest: digest("8"),
    providerReleaseIdentityDigest: digest("9"),
    ambientProviderDiscoveryPoisoned: true,
    writeLifecycleCapabilityDigest: digest("a")
  };
}

function completionEvidence() {
  return {
    schemaVersion: 1,
    scenario: "official-grok-build-target-txt-write-smoke",
    workerId: "task-completion",
    status: "completed",
    providerGeneration: 2,
    reportSource: "acp-structured",
    reportDigest: digest("b"),
    nativeStructuredOutput: true,
    targetPath: "target.txt",
    baseCommit: "c".repeat(40),
    manifestDigest: digest("c"),
    patchDigest: digest("d"),
    contentDigest: digest("e"),
    parentFingerprintDigest: digest("f"),
    parentUnchangedBeforeIntegration: true,
    integrationApplied: true,
    runnerDisposableWorktreeRemoved: true,
    runnerWorktreeRegistrationAbsent: true,
    productionIntegrationQualified: true,
    productionCleanupQualified: true,
    hostVerification: "passed",
    integrationReceiptDigest: digest("0"),
    hostVerificationDigest: digest("1"),
    cleanupReceiptDigest: digest("2"),
    absenceProofDigest: digest("3"),
    spawnReplayProven: true,
    artifactReplayProven: true,
    artifactReplayAfterCleanupProven: true,
    spawnReplayNoDispatch: true,
    providerGenerationDelta: 0,
    primaryTurnAdmissionDelta: 0,
    worktreeIdentityChanged: false,
    integrationReplayProven: true,
    cleanupReplayProven: true,
    providerSessionAbsent: true,
    activeWriteCancellationProven: true,
    writeCancellation: {
      workerId: "task-cancellation",
      status: "cancelled",
      activeProviderObserved: true,
      spawnReplayProven: true,
      spawnReplayNoDispatch: true,
      providerGenerationDelta: 0,
      providerProcessIdentityChanged: false,
      worktreeIdentityChanged: false,
      runtimeIdentityChanged: false,
      cancelReplayProven: true,
      taskRuntimeCleaned: true,
      parentUnchanged: true,
      artifactAbsent: true,
      cleanupDisposition: "discarded",
      cleanupReceiptDigest: digest("4"),
      terminalEvidenceDigest: digest("5"),
      absenceProofDigest: digest("6"),
      cleanupReplayProven: true,
      providerSessionAbsent: true,
      worktreeAbsent: true
    },
    ...commonBindings()
  };
}

function twoWriterEvidence() {
  return {
    schemaVersion: 1,
    scenario: "official-grok-build-two-writer-conflict",
    workers: {
      a: {
        id: "task-writer-a",
        executionBindingDigest: digest("b"),
        executionRootDigest: digest("c"),
        providerProcessDigest: digest("d"),
        manifestDigest: digest("e"),
        patchDigest: digest("f"),
        contentDigest: digest("0"),
        readyObservationDigest: digest("1"),
        integrationReceiptDigest: digest("2"),
        verificationObservationDigest: digest("3"),
        cleanupReceiptDigest: digest("4")
      },
      b: {
        id: "task-writer-b",
        executionBindingDigest: digest("5"),
        executionRootDigest: digest("6"),
        providerProcessDigest: digest("7"),
        manifestDigest: digest("8"),
        patchDigest: digest("9"),
        contentDigest: digest("a"),
        readyObservationDigest: digest("b"),
        conflictObservationDigest: digest("c"),
        conflictClassification: "parent-drift",
        rejectedIntegrationCode: "E_INTEGRATION",
        rejectedIntegrationMessageDigest: digest("d"),
        abandonReceiptDigest: digest("e")
      }
    },
    providerOverlap: {
      proven: true,
      observedAt: 1_790_000_000_000,
      observationDigest: digest("f"),
      rootsDistinct: true
    },
    parent: {
      baseCommit: "d".repeat(40),
      beforeFingerprintDigest: digest("1"),
      unchangedBeforeIntegration: true,
      indexUnchangedBeforeIntegration: true,
      integratedContentDigest: digest("0"),
      rejectedIntegrationNoEffect: true,
      abandonNoEffect: true
    },
    replay: {
      retainedArtifactBAfterReconnect: true,
      verificationA: true,
      integrationA: true,
      cleanupA: true,
      abandonB: true,
      immutableArtifactsAfterCleanup: true
    },
    absence: {
      sessions: true,
      worktrees: true,
      guards: true,
      processes: true
    },
    ...commonBindings()
  };
}

function clone(value) {
  return structuredClone(value);
}

test("Phase 3 live producer binds exact completion, cancellation, concurrency, conflict, replay, and absence evidence", () => {
  const completion = completionEvidence();
  const twoWriter = twoWriterEvidence();
  assert.equal(validatePhaseThreeCompletionEvidence(completion).ok, true);
  assert.equal(validatePhaseThreeTwoWriterEvidence(twoWriter).ok, true);

  const receipt = buildPhaseThreeLiveReceipt({
    completionEvidence: completion,
    twoWriterEvidence: twoWriter,
    recordedAt: "2026-07-26T10:00:00.000Z",
    root: ROOT
  });
  assert.equal(receipt.evidenceClass, "supporting-live-unqualified");
  assert.equal(receipt.phase, "3");
  assert.equal(receipt.provider.implementation, "official-grok-build-acp");
  assert.equal(receipt.provider.version, "0.2.112");
  assert.equal(receipt.completion.providerGeneration, 2);
  assert.deepEqual(receipt.gates, PHASE_THREE_LIVE_GATE_IDS);
  assert.equal(receipt.completion.workerId, completion.workerId);
  assert.equal(receipt.cancellation.workerId, completion.writeCancellation.workerId);
  assert.deepEqual(receipt.concurrency.executionRootDigests, [
    twoWriter.workers.a.executionRootDigest,
    twoWriter.workers.b.executionRootDigest
  ]);
  assert.equal(receipt.conflict.classification, "parent-drift");
  assert.equal(receipt.conflict.errorCode, "E_INTEGRATION");
  assert.deepEqual(receipt.inputs.completion.projection, completion);
  assert.deepEqual(receipt.inputs.twoWriter.projection, twoWriter);
  assert.notEqual(receipt.inputs.completion.projection, completion);
  assert.notEqual(receipt.inputs.twoWriter.projection, twoWriter);
  assert.equal(
    receipt.inputs.completion.digest,
    computePhaseThreeLiveInputDigest(completion)
  );
  assert.equal(
    receipt.inputs.twoWriter.digest,
    computePhaseThreeLiveInputDigest(twoWriter)
  );
  assert.equal(receipt.receiptDigest, computePhaseThreeLiveReceiptDigest(receipt));
  assert.equal(validatePhaseThreeLiveReceipt(receipt).ok, true);
  assert.equal(Object.hasOwn(receipt, "qualification"), false);
  assert.equal(Object.hasOwn(receipt, "releaseQualification"), false);
  assert.match(
    phaseThreeLiveReceiptRelativePath(receipt),
    /^tests\/e2e-results\/worker-broker\/live-receipts\/phase-3\/v1\/[a-f0-9]{16}-[a-f0-9]{16}\.json$/
  );
});

test("Phase 3 live inputs fail closed when any mandatory real-lifecycle gate is weakened", () => {
  const completionMutations = [
    (value) => { value.nativeStructuredOutput = false; },
    (value) => { value.productionIntegrationQualified = false; },
    (value) => { value.integrationReplayProven = false; },
    (value) => { value.writeCancellation.activeProviderObserved = false; },
    (value) => { value.writeCancellation.worktreeAbsent = false; },
    (value) => { value.ambientProviderDiscoveryPoisoned = false; }
  ];
  for (const mutate of completionMutations) {
    const value = completionEvidence();
    mutate(value);
    assert.equal(validatePhaseThreeCompletionEvidence(value).ok, false);
  }

  const twoWriterMutations = [
    (value) => { value.providerOverlap.proven = false; },
    (value) => {
      value.workers.b.executionRootDigest =
        value.workers.a.executionRootDigest;
    },
    (value) => { value.workers.b.conflictClassification = "ready"; },
    (value) => { value.parent.rejectedIntegrationNoEffect = false; },
    (value) => { value.replay.abandonB = false; },
    (value) => { value.absence.processes = false; }
  ];
  for (const mutate of twoWriterMutations) {
    const value = twoWriterEvidence();
    mutate(value);
    assert.equal(validatePhaseThreeTwoWriterEvidence(value).ok, false);
  }
});

test("Phase 3 live producer rejects mismatched source, install, provider, or capability identities", () => {
  for (const field of [
    "sourceHeadCommit",
    "sourceHeadTree",
    "sourceInventoryDigest",
    "sourcePluginInventoryDigest",
    "installedEntrypointDigest",
    "providerVersion",
    "providerBinaryDigest",
    "providerCapabilityDigest",
    "providerPinRef",
    "providerLaunchBindingDigest",
    "providerExecutableIdentityDigest",
    "providerReleaseIdentityDigest",
    "writeLifecycleCapabilityDigest"
  ]) {
    const completion = completionEvidence();
    const twoWriter = twoWriterEvidence();
    twoWriter[field] = field === "providerVersion"
      ? "0.2.113"
      : field === "providerPinRef"
        ? `gpin-${"f".repeat(32)}`
        : field.endsWith("Commit") || field.endsWith("Tree")
          ? "f".repeat(40)
          : digest("f");
    assert.throws(
      () => buildPhaseThreeLiveReceipt({
        completionEvidence: completion,
        twoWriterEvidence: twoWriter,
        root: ROOT
      }),
      (error) => error?.code === "E_PHASE3_LIVE_EVIDENCE_INVALID"
    );
  }
});

test("Phase 3 live receipt replay and immutable publication fail closed under tampering and hostile paths", () => {
  const receipt = buildPhaseThreeLiveReceipt({
    completionEvidence: completionEvidence(),
    twoWriterEvidence: twoWriterEvidence(),
    recordedAt: "2026-07-26T10:00:00.000Z",
    root: ROOT
  });
  const tampered = clone(receipt);
  tampered.conflict.classification = "ready";
  tampered.receiptDigest = computePhaseThreeLiveReceiptDigest(tampered);
  assert.equal(validatePhaseThreeLiveReceipt(tampered).ok, false);

  const weakenedInput = clone(receipt);
  weakenedInput.inputs.completion.projection.productionCleanupQualified = false;
  weakenedInput.inputs.completion.digest = computePhaseThreeLiveInputDigest(
    weakenedInput.inputs.completion.projection
  );
  weakenedInput.receiptDigest = computePhaseThreeLiveReceiptDigest(weakenedInput);
  assert.equal(validatePhaseThreeLiveReceipt(weakenedInput).ok, false);

  const detachedProjection = clone(receipt);
  detachedProjection.inputs.completion.projection.providerGeneration += 1;
  detachedProjection.inputs.completion.digest = computePhaseThreeLiveInputDigest(
    detachedProjection.inputs.completion.projection
  );
  detachedProjection.receiptDigest = computePhaseThreeLiveReceiptDigest(
    detachedProjection
  );
  assert.equal(validatePhaseThreeLiveReceipt(detachedProjection).ok, false);
  assert.match(
    validatePhaseThreeLiveReceipt(detachedProjection).errors.join("\n"),
    /projections do not match replayable inputs/i
  );

  const stale = validatePhaseThreeLiveReceipt(receipt, {
    strict: true,
    root: ROOT
  });
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join("\n"), /stale|clean non-evidence source/);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-receipt-"));
  const variant = (offset) => {
    const value = clone(receipt);
    value.recordedAt = new Date(
      Date.parse(receipt.recordedAt) + offset * 1_000
    ).toISOString();
    value.receiptDigest = computePhaseThreeLiveReceiptDigest(value);
    return value;
  };
  const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
  try {
    const relative = phaseThreeLiveReceiptRelativePath(receipt);
    const contents = serialize(receipt);
    let fsyncCount = 0;
    const originalFsyncSync = fs.fsyncSync;
    fs.fsyncSync = (...args) => {
      fsyncCount += 1;
      return originalFsyncSync(...args);
    };
    try {
      assert.equal(
        publishImmutableEvidenceArtifact({
          root: temporaryRoot,
          relative,
          contents
        }),
        relative
      );
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
    assert.ok(fsyncCount >= (process.platform === "win32" ? 1 : 2));
    const absolute = path.join(temporaryRoot, ...relative.split("/"));
    assert.equal(fs.lstatSync(absolute).isFile(), true);
    assert.equal(fs.readFileSync(absolute, "utf8"), contents);
    assert.equal(
      publishImmutableEvidenceArtifact({
        root: temporaryRoot,
        relative,
        contents
      }),
      relative,
      "an exact immutable EEXIST replay must converge"
    );
    assert.throws(
      () => publishImmutableEvidenceArtifact({
        root: temporaryRoot,
        relative,
        contents: serialize(variant(1))
      }),
      (error) => error?.code === "E_EVIDENCE_FILE_UNSAFE"
    );
    assert.equal(fs.readFileSync(absolute, "utf8"), contents);

    const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-outside-"));
    try {
      fs.symlinkSync(outside, path.join(symlinkRoot, "tests"), "dir");
      assert.throws(
        () => publishImmutableEvidenceArtifact({
          root: symlinkRoot,
          relative,
          contents
        }),
        (error) => error?.code === "E_EVIDENCE_FILE_UNSAFE"
      );
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(symlinkRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }

    if (process.platform !== "win32") {
      const fifoReceipt = variant(2);
      const fifoRelative = phaseThreeLiveReceiptRelativePath(fifoReceipt);
      const fifoAbsolute = path.join(
        temporaryRoot,
        ...fifoRelative.split("/")
      );
      execFileSync("mkfifo", [fifoAbsolute]);
      assert.throws(
        () => publishImmutableEvidenceArtifact({
          root: temporaryRoot,
          relative: fifoRelative,
          contents: serialize(fifoReceipt)
        }),
        (error) => error?.code === "E_EVIDENCE_FILE_UNSAFE"
      );
      assert.equal(fs.lstatSync(fifoAbsolute).isFIFO(), true);
    }

    const racedReceipt = variant(3);
    const racedRelative = phaseThreeLiveReceiptRelativePath(racedReceipt);
    const racedAbsolute = path.join(
      temporaryRoot,
      ...racedRelative.split("/")
    );
    const originalLinkSync = fs.linkSync;
    fs.linkSync = (source, destination) => {
      fs.writeFileSync(destination, "attacker-controlled\n", { flag: "wx" });
      return originalLinkSync(source, destination);
    };
    try {
      assert.throws(
        () => publishImmutableEvidenceArtifact({
          root: temporaryRoot,
          relative: racedRelative,
          contents: serialize(racedReceipt)
        }),
        (error) => error?.code === "E_EVIDENCE_FILE_UNSAFE"
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(fs.readFileSync(racedAbsolute, "utf8"), "attacker-controlled\n");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  assert.equal(typeof writePhaseThreeLiveReceipt, "function");
});

test("Phase 3 live CLI exposes only the offline build and verify workflow", () => {
  const help = execFileSync(
    process.execPath,
    ["scripts/worker-broker-phase3-evidence.mjs", "--help"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.match(help, /build --completion <json> --two-writer <json> \[--write\]/);
  assert.match(help, /never runs Grok/);
  assert.match(help, /supporting-live-unqualified/);
  assert.deepEqual(PHASE_THREE_LIVE_RECEIPT_MANIFEST.gateIds, PHASE_THREE_LIVE_GATE_IDS);
});
