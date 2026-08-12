import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDurableSpawnRequestBinding,
  assertManagedWritePostBindingObservation
} from "../plugins/grok/scripts/lib/worker-mutation-spawn-authority.mjs";

test("assertManagedWritePostBindingObservation fails closed on incompleteComponents", () => {
  assert.throws(
    () => assertManagedWritePostBindingObservation({
      coreReasons: [],
      metadataMarkers: [],
      scopeViolations: ["[GIT_METADATA_INCOMPLETE]"],
      incompleteComponents: ["gitMetadata"]
    }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
  );
});

test("assertManagedWritePostBindingObservation ignores sole GIT_METADATA_INCOMPLETE scope marker when complete", () => {
  assert.doesNotThrow(() => assertManagedWritePostBindingObservation({
    coreReasons: [],
    metadataMarkers: [],
    scopeViolations: ["[GIT_METADATA_INCOMPLETE]"],
    incompleteComponents: []
  }));
});

test("assertDurableSpawnRequestBinding accepts admission contextPhase option", () => {
  // Signature contract: options bag is accepted (not TypeError on third arg).
  // Malformed jobs still fail closed with spawn idempotency/state errors.
  assert.throws(
    () => assertDurableSpawnRequestBinding(
      { request: { spawn: {} }, host: { sessionId: "t" } },
      process.env,
      { contextPhase: "admission" }
    ),
    (error) => error?.code === "E_STATE" || error?.code === "E_USAGE" || typeof error?.message === "string"
  );
  const arity = assertDurableSpawnRequestBinding.length;
  assert.ok(arity >= 0 && arity <= 2, "optional trailing options must not break arity");
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECOVERY = path.join(
  HERE,
  "../plugins/grok/scripts/lib/worker-mutation-write-recovery.mjs"
);

test("host adoption captures complete execute-phase context", () => {
  const source = fs.readFileSync(RECOVERY, "utf8");
  assert.match(
    source,
    /captureCompleteContextManifest\(\s*verified\.binding\.expectedExecutionRoot\s*,\s*\{\s*contextPhase:\s*"execute"\s*\}/
  );
  assert.doesNotMatch(
    source,
    /const executionContextManifest = captureContextManifest\(\s*verified\.binding\.expectedExecutionRoot\s*\)/
  );
});
