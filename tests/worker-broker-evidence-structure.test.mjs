import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  PHASE_SCOPE,
  PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
  expandLocalStaticImportClosure,
  listLocalStaticImportSpecifiers
} from "../scripts/lib/worker-broker-evidence.mjs";
import {
  WORKER_MUTATION_SEMANTIC_TEST_FILES
} from "../scripts/lib/worker-mutation-test-inventory.mjs";
import {
  DETERMINISTIC_AGGREGATE_TEST_FILES,
  WORKER_BROKER_EVIDENCE_SEMANTIC_TEST_FILES
} from "../scripts/lib/deterministic-test-shards.mjs";
import { ROOT } from "./helpers.mjs";

const EXPECTED_PROTECTED_RUNTIME_BUNDLE = Object.freeze([
  "package-lock.json",
  "package.json",
  "plugins/grok/scripts/lib/redact.mjs",
  "scripts/lib/plugin-inventory.mjs",
  "scripts/lib/static-esm-import-parser.mjs",
  "scripts/lib/worker-broker-evidence-authority.mjs",
  "scripts/lib/worker-broker-evidence-core.mjs",
  "scripts/lib/worker-broker-evidence-files.mjs",
  "scripts/lib/worker-broker-evidence-inventory.mjs",
  "scripts/lib/worker-broker-evidence-ledger.mjs",
  "scripts/lib/worker-broker-evidence-proof.mjs",
  "scripts/lib/worker-broker-evidence-protected-trust.mjs",
  "scripts/lib/worker-broker-evidence-record.mjs",
  "scripts/lib/worker-broker-evidence-review.mjs",
  "scripts/lib/worker-broker-evidence-toolchain.mjs",
  "scripts/lib/worker-broker-evidence-verification.mjs",
  "scripts/lib/worker-mutation-test-inventory.mjs",
  "scripts/trusted/worker-broker-review-operation.cjs",
  "scripts/trusted/worker-broker-review.mjs"
]);

test("evidence facade pins the public surface without protected authority", async () => {
  const facadePath = path.join(ROOT, "scripts/lib/worker-broker-evidence.mjs");
  const publicModule = await import(
    `${pathToFileURL(facadePath).href}?facade-boundary=${crypto.randomBytes(8).toString("hex")}`
  );
  const exportNames = Object.keys(publicModule);
  assert.equal(exportNames.length, 97);
  assert.equal(
    crypto.createHash("sha256").update(JSON.stringify(exportNames)).digest("hex"),
    "2b0fcd3d63f422f4516fb9d6fe7435bbace3443a48bc2d0821ed0134994f84a8"
  );

  const publicEvidenceModules = expandLocalStaticImportClosure([
    "scripts/lib/worker-broker-evidence.mjs"
  ]).filter((relative) => relative.startsWith(
    "scripts/lib/worker-broker-evidence-"
  ));
  assert.deepEqual(publicEvidenceModules, [
    "scripts/lib/worker-broker-evidence-core.mjs",
    "scripts/lib/worker-broker-evidence-files.mjs",
    "scripts/lib/worker-broker-evidence-inventory.mjs",
    "scripts/lib/worker-broker-evidence-ledger.mjs",
    "scripts/lib/worker-broker-evidence-proof-runner.mjs",
    "scripts/lib/worker-broker-evidence-proof.mjs",
    "scripts/lib/worker-broker-evidence-record.mjs",
    "scripts/lib/worker-broker-evidence-review-request.mjs",
    "scripts/lib/worker-broker-evidence-review.mjs",
    "scripts/lib/worker-broker-evidence-toolchain.mjs",
    "scripts/lib/worker-broker-evidence-verification.mjs"
  ]);
  assert.equal(
    publicEvidenceModules.includes("scripts/lib/worker-broker-evidence-authority.mjs"),
    false
  );
  assert.equal(
    publicEvidenceModules.includes("scripts/lib/worker-broker-evidence-protected-trust.mjs"),
    false
  );

  const authorityModule = await import(
    `${pathToFileURL(path.join(
      ROOT,
      "scripts/lib/worker-broker-evidence-authority.mjs"
    )).href}?authority-boundary=${crypto.randomBytes(8).toString("hex")}`
  );
  assert.deepEqual(Object.keys(authorityModule), []);
});

test("phase scopes bind semantic evidence and mutation suites without ordinal partitions", () => {
  assert.deepEqual(DETERMINISTIC_AGGREGATE_TEST_FILES, [
    "tests/worker-broker-evidence.test.mjs"
  ]);
  const aggregateSource = fs.readFileSync(
    path.join(ROOT, DETERMINISTIC_AGGREGATE_TEST_FILES[0]),
    "utf8"
  );
  const aggregateImports = listLocalStaticImportSpecifiers(aggregateSource).map(
    (specifier) => `tests/${specifier.slice(2)}`
  );
  assert.equal(
    aggregateSource,
    `${WORKER_BROKER_EVIDENCE_SEMANTIC_TEST_FILES.map(
      (relative) => `import "./${path.basename(relative)}";`
    ).join("\n")}\n`
  );
  assert.deepEqual(
    aggregateImports,
    [...WORKER_BROKER_EVIDENCE_SEMANTIC_TEST_FILES].sort()
  );
  assert.equal(new Set(aggregateImports).size, aggregateImports.length);
  assert.ok(aggregateSource.split("\n").length <= 12);

  const retiredEvidencePartitions = Array.from(
    { length: 9 },
    (_unused, index) => `tests/worker-broker-evidence_part${index + 1}.mjs`
  );
  for (const phase of ["0", "1", "2", "3", "4"]) {
    for (const relative of [
      ...DETERMINISTIC_AGGREGATE_TEST_FILES,
      ...WORKER_BROKER_EVIDENCE_SEMANTIC_TEST_FILES,
      "tests/worker-broker-evidence-structure.test.mjs",
      "tests/worker-broker-evidence-test-support.mjs",
      "tests/worker-broker-evidence-private-harness.mjs"
    ]) {
      assert.equal(
        PHASE_SCOPE[phase].filter((candidate) => candidate === relative).length,
        1,
        `${relative} must occur exactly once in Phase ${phase}`
      );
    }
    assert.equal(
      retiredEvidencePartitions.some((relative) => PHASE_SCOPE[phase].includes(relative)),
      false
    );
  }

  assert.deepEqual(WORKER_MUTATION_SEMANTIC_TEST_FILES, [
    "tests/worker-mutation-spawn-context.test.mjs",
    "tests/worker-mutation-provisioning-intent.test.mjs",
    "tests/worker-mutation-provisioning-adoption.test.mjs",
    "tests/worker-mutation-admission-dispatch.test.mjs",
    "tests/worker-mutation-terminal-evidence.test.mjs",
    "tests/worker-mutation-cancellation-recovery.test.mjs",
    "tests/worker-mutation-service-mcp.test.mjs"
  ]);
  const supportFiles = [
    "tests/worker-mutation-test-support.mjs",
    "tests/worker-mutation-provisioning-test-support.mjs",
    "tests/worker-mutation-terminal-test-support.mjs"
  ];
  const retired = [
    "tests/worker-mutation.test.mjs",
    "tests/worker-mutation_part1.mjs",
    "tests/worker-mutation_part2.mjs"
  ];
  for (const phase of ["0", "1", "2", "3", "5"]) {
    for (const relative of [
      ...WORKER_MUTATION_SEMANTIC_TEST_FILES,
      ...supportFiles
    ]) {
      assert.equal(
        PHASE_SCOPE[phase].filter((candidate) => candidate === relative).length,
        1,
        `${relative} must occur exactly once in Phase ${phase}`
      );
    }
    assert.equal(
      PHASE_SCOPE[phase].includes("tests/worker-mutation-boundaries.test.mjs"),
      new Set(["0", "1"]).has(phase)
    );
    assert.equal(retired.some((relative) => PHASE_SCOPE[phase].includes(relative)), false);
  }
});

test("protected runtime bundle is exact, closed, and bootstrap-owned", () => {
  assert.deepEqual(
    PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
    EXPECTED_PROTECTED_RUNTIME_BUNDLE
  );
  assert.deepEqual(
    [...PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS],
    [...PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS].sort()
  );

  const bootstrap = fs.readFileSync(
    path.join(ROOT, "scripts/trusted/worker-broker-review.mjs"),
    "utf8"
  );
  const bootstrapBundleLiteral = /const RUNTIME_BUNDLE_PATHS = Object\.freeze\((\[[\s\S]*?\])\);/u
    .exec(bootstrap)?.[1];
  assert.equal(typeof bootstrapBundleLiteral, "string");
  assert.deepEqual(
    JSON.parse(bootstrapBundleLiteral),
    PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS
  );

  const operation = fs.readFileSync(
    path.join(ROOT, "scripts/trusted/worker-broker-review-operation.cjs"),
    "utf8"
  );
  assert.equal(operation.includes("worker-broker-evidence-authority.mjs"), true);
  assert.equal(operation.includes("worker-broker-evidence.mjs"), false);

  for (const relative of ["package.json", "package-lock.json"]) {
    const stat = fs.lstatSync(path.join(ROOT, relative));
    assert.equal(stat.isFile(), true, `${relative} must be a regular file`);
    assert.equal(stat.isSymbolicLink(), false, `${relative} must not be a symlink`);
  }
  const parser = fs.readFileSync(
    path.join(ROOT, "scripts/lib/static-esm-import-parser.mjs"),
    "utf8"
  );
  assert.deepEqual(listLocalStaticImportSpecifiers(parser), []);
});
