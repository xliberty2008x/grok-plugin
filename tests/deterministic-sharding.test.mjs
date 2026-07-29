import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateHostedCiWorkflow } from "../scripts/lib/ci-workflow-contract.mjs";
import {
  EXTERNAL_BOUNDARY_TESTS,
  listDeterministicTestFiles
} from "../scripts/test-deterministic.mjs";
import {
  DETERMINISTIC_TEST_SHARD_COUNT,
  DETERMINISTIC_TEST_SHARDS,
  parseDeterministicShardArgument,
  selectDeterministicTestFiles,
  validateDeterministicTestShards
} from "../scripts/lib/deterministic-test-shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("deterministic shard manifest is an exact nonempty partition of the inventory", () => {
  const inventory = listDeterministicTestFiles();
  assert.equal(DETERMINISTIC_TEST_SHARDS.length, DETERMINISTIC_TEST_SHARD_COUNT);
  assert.ok(DETERMINISTIC_TEST_SHARDS.every((files) => files.length > 0));
  assert.deepEqual(
    validateDeterministicTestShards({
      inventory,
      externalBoundaryTests: EXTERNAL_BOUNDARY_TESTS
    }),
    []
  );

  const combined = DETERMINISTIC_TEST_SHARDS.flat();
  assert.equal(new Set(combined).size, combined.length);
  assert.deepEqual([...combined].sort(), inventory);
  assert.ok(EXTERNAL_BOUNDARY_TESTS.every((file) => !combined.includes(`tests/${file}`)));
});

test("deterministic shard CLI accepts only one exact three-way shard specification", () => {
  assert.equal(parseDeterministicShardArgument([]), null);
  assert.equal(parseDeterministicShardArgument(["--shard=1/3"]), 1);
  assert.equal(parseDeterministicShardArgument(["--shard=2/3"]), 2);
  assert.equal(parseDeterministicShardArgument(["--shard=3/3"]), 3);

  const invalid = [
    ["--shard=0/3"],
    ["--shard=4/3"],
    ["--shard=1/2"],
    ["--shard=01/3"],
    ["--shard", "1/3"],
    ["--shard=1/3", "--shard=2/3"],
    ["--unknown"],
    [""]
  ];
  for (const argv of invalid) {
    assert.throws(() => parseDeterministicShardArgument(argv), Error, JSON.stringify(argv));
  }
  assert.throws(() => parseDeterministicShardArgument(null), TypeError);
});

test("default selection stays unsharded and shard selection preserves manifest order", () => {
  const inventory = listDeterministicTestFiles();
  assert.deepEqual(
    selectDeterministicTestFiles({ inventory, shard: null }),
    inventory
  );
  for (let shard = 1; shard <= DETERMINISTIC_TEST_SHARD_COUNT; shard += 1) {
    assert.deepEqual(
      selectDeterministicTestFiles({ inventory, shard }),
      DETERMINISTIC_TEST_SHARDS[shard - 1]
    );
  }
  assert.throws(() => selectDeterministicTestFiles({ inventory, shard: 0 }), Error);
  assert.throws(() => selectDeterministicTestFiles({ inventory, shard: 4 }), Error);
});

test("manifest validation fails closed on missing, duplicate, extra, external, and empty entries", () => {
  const inventory = listDeterministicTestFiles();
  const mutable = DETERMINISTIC_TEST_SHARDS.map((files) => [...files]);

  const missing = mutable.map((files) => [...files]);
  missing[0].shift();
  assert.ok(validateDeterministicTestShards({ inventory, shards: missing })
    .some((message) => /missing inventory tests/u.test(message)));

  const duplicate = mutable.map((files) => [...files]);
  duplicate[1].push(duplicate[0][0]);
  assert.ok(validateDeterministicTestShards({ inventory, shards: duplicate })
    .some((message) => /duplicate tests/u.test(message)));

  const extra = mutable.map((files) => [...files]);
  extra[0].push("tests/untracked-extra.test.mjs");
  extra[0].sort();
  assert.ok(validateDeterministicTestShards({ inventory, shards: extra })
    .some((message) => /outside the inventory/u.test(message)));

  const external = mutable.map((files) => [...files]);
  external[0].push(`tests/${EXTERNAL_BOUNDARY_TESTS[0]}`);
  external[0].sort();
  assert.ok(validateDeterministicTestShards({
    inventory,
    externalBoundaryTests: EXTERNAL_BOUNDARY_TESTS,
    shards: external
  }).some((message) => /external-boundary test/u.test(message)));

  const empty = mutable.map((files) => [...files]);
  empty[2] = [];
  assert.ok(validateDeterministicTestShards({ inventory, shards: empty })
    .some((message) => /nonempty array/u.test(message)));
});

test("hosted CI contract rejects matrix and gate mutations that could hide coverage failures", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(validateHostedCiWorkflow(workflow), []);
  assert.deepEqual(validateHostedCiWorkflow(workflow.replace(/\n/gu, "\r\n")), []);

  const mutations = [
    workflow.replace(
      "        shard: [1, 2, 3]",
      "        shard: [1, 2, 3]\n        exclude:\n          - os: macos-latest\n            node: 18.18.2\n            shard: 3"
    ),
    workflow.replace(
      "    timeout-minutes: 20",
      "    timeout-minutes: 20\n    continue-on-error: true"
    ),
    workflow.replace(
      "        run: npm run test:pty-ingress",
      "        continue-on-error: true\n        run: npm run test:pty-ingress"
    ),
    workflow.replace(
      "      matrix:\n        os: [ubuntu-latest, macos-latest]",
      "      matrix:\n        os: [ubuntu-latest, macos-latest]\n        exclude:\n          - os: macos-latest"
    ),
    workflow.replace(
      [
        "  windows-neutral:",
        "    name: windows-latest / Node ${{ matrix.node }}",
        "    runs-on: windows-latest",
        "    timeout-minutes: 45",
        "    strategy:",
        "      fail-fast: false",
        "      matrix:",
        "        node: [18.18.2, 22.x]"
      ].join("\n"),
      [
        "  windows-neutral:",
        "    name: windows-latest / Node ${{ matrix.node }}",
        "    runs-on: windows-latest",
        "    timeout-minutes: 45",
        "    strategy:",
        "      fail-fast: false",
        "      matrix:",
        "        node: [18.18.2, 22.x]",
        "        exclude:",
        "          - node: 18.18.2"
      ].join("\n")
    ),
    workflow.replace(
      "PTY_INGRESS_RESULT: ${{ needs['pty-ingress'].result }}",
      "PTY_INGRESS_RESULT: ${{ needs['pty-ingress'].result && 'success' }}"
    ),
    workflow.replace(
      "      - name: Run deterministic zero-skip shard",
      "      - name: Run deterministic zero-skip shard\n        if: false"
    ),
    workflow.replace(
      "        if: matrix.shard == 1",
      "        if: matrix.shard == 12"
    ),
    workflow.replace(
      "        if: matrix.shard == 1",
      "        if: matrix.shard == 1 && false"
    ),
    workflow.replace(
      "        run: npm run test:deterministic -- --shard=${{ matrix.shard }}/3",
      "        shell: bash {0} || true\n        run: npm run test:deterministic -- --shard=${{ matrix.shard }}/3"
    ),
    workflow.replace(
      "      - name: Run source PTY ingress regression",
      "      - name: Run source PTY ingress regression\n        if: false"
    ),
    workflow.replace(
      "      - name: Run provider-neutral tests (Windows; provider unverified)",
      "      - name: Run provider-neutral tests (Windows; provider unverified)\n        if: false"
    ),
    workflow.replace(
      "      - name: Validate release structure\n        run: npm run validate",
      "      - name: Validate release structure\n        if: false\n        run: npm run validate"
    ),
    workflow.replace(
      "        run: |\n          if [ \"$PTY_INGRESS_RESULT\"",
      "        run: |\n          if false; then\n            exit 0\n          fi\n          if [ \"$PTY_INGRESS_RESULT\""
    ),
    workflow.replace("  pull_request:\n", ""),
    workflow.replace("    branches: [main]\n", "    branches: [release]\n"),
    workflow.replace("  workflow_dispatch:\n", "")
  ];
  for (const mutated of mutations) {
    assert.notDeepEqual(validateHostedCiWorkflow(mutated), [], "mutation must fail closed");
  }
});
