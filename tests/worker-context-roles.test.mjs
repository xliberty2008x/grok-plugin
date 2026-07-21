import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONTEXT_FACTS,
  assertNoHiddenExport,
  buildContextPacket,
  transcriptAcquisitionCapability
} from "../plugins/grok/scripts/lib/worker-context.mjs";
import {
  assertRoleDigest,
  grantHostAction,
  materializeRole,
  requestHostAction
} from "../plugins/grok/scripts/lib/worker-roles.mjs";

test("context bounds are enforced after envelope insertion and per fact", () => {
  const packet = buildContextPacket({
    envelope: { userRequest: "objective", objective: "objective" },
    facts: Array.from({ length: MAX_CONTEXT_FACTS + 10 }, (_, index) => `fact-${index}-${"x".repeat(40)}`),
    bounds: { maxFacts: 3, maxFactChars: 12 },
    omissions: ["visible omission", "api_key=do-not-export"]
  });
  assert.equal(packet.facts.length, 3);
  assert.equal(packet.facts[0], "objective");
  assert.ok(packet.facts.every((fact) => fact.length <= 12));
  assert.equal(packet.bounds.effectiveMaxFacts, 3);
  assert.ok(packet.omissions.includes("visible omission"));
  assert.equal(packet.omissions.some((item) => item.includes("do-not-export")), false);
});

test("strong transcript modes stay disabled without broker-bound attestation", () => {
  assert.throws(
    () => buildContextPacket({ mode: "recent:0" }),
    (error) => error?.code === "E_USAGE"
  );
  assert.throws(
    () => buildContextPacket({ mode: `recent:${MAX_CONTEXT_FACTS + 1}` }),
    (error) => error?.code === "E_USAGE"
  );
  const forgedHelperClaim = transcriptAcquisitionCapability({ proven: true, privacyFiltered: true });
  assert.equal(forgedHelperClaim.recentNEnabled, false);
  for (const transcriptCapability of [
    forgedHelperClaim,
    { proven: true, privacyFiltered: true, recentNEnabled: true, allUserVisibleEnabled: true }
  ]) {
    assert.throws(
      () => buildContextPacket({
        mode: "recent:2",
        facts: ["one", "two", "three"],
        transcriptCapability
      }),
      (error) => error?.code === "E_CAPABILITY"
    );
    assert.throws(
      () => buildContextPacket({ mode: "all-user-visible", transcriptCapability }),
      (error) => error?.code === "E_CAPABILITY"
    );
  }
});

test("context filtering rejects broad credential formats and packets are deeply immutable", () => {
  const githubTokenCanary = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz", "1234567890"].join("");
  const postgresCanary = [
    "post",
    "gresql",
    "://",
    "worker",
    ":",
    "hunter2",
    "@",
    "db.example.test",
    "/app"
  ].join("");
  const secrets = [
    githubTokenCanary,
    "AKIAIOSFODNN7EXAMPLE",
    "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    postgresCanary,
    "password=correct-horse-battery-staple",
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----"
  ];
  const packet = buildContextPacket({
    envelope: { userRequest: "Inspect public documentation", objective: "Inspect public documentation" },
    facts: ["visible fact", ...secrets],
    omissions: ["visible omission", ...secrets]
  });
  assertNoHiddenExport(packet);
  assert.ok(packet.facts.includes("visible fact"));
  const serialized = JSON.stringify(packet);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);

  assert.ok(Object.isFrozen(packet));
  assert.ok(Object.isFrozen(packet.facts));
  assert.ok(Object.isFrozen(packet.omissions));
  assert.ok(Object.isFrozen(packet.provenance));
  assert.ok(Object.isFrozen(packet.provenance.precedence));
  assert.ok(Object.isFrozen(packet.bounds));
  const originalDigest = packet.digest;
  assert.throws(() => packet.facts.push("post-digest mutation"), TypeError);
  assert.throws(() => packet.provenance.precedence.push("forged-source"), TypeError);
  assert.equal(packet.digest, originalDigest);

  const none = buildContextPacket({ mode: "none" });
  assert.ok(Object.isFrozen(none.facts));
  assert.ok(Object.isFrozen(none.provenance));
});

test("roles are deeply immutable and host grants remain fail closed", () => {
  const explorer = materializeRole("explorer");
  assert.ok(Object.isFrozen(explorer));
  assert.ok(Object.isFrozen(explorer.tools));
  assert.throws(
    () => assertRoleDigest({ ...explorer, tools: ["read", "edit"], digest: explorer.digest }),
    (error) => error?.code === "E_ROLE"
  );
  const request = requestHostAction(explorer, { kind: "escalate_role", roleId: "implementer" });
  assert.throws(
    () => grantHostAction({ hostKind: "codex" }, request, { roleId: "implementer" }),
    (error) => error?.code === "E_CAPABILITY"
  );
});
