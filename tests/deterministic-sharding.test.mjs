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
  DETERMINISTIC_AGGREGATE_TEST_FILES,
  DETERMINISTIC_SUPPORT_TEST_FILES,
  DETERMINISTIC_TEST_SHARD_COUNT,
  DETERMINISTIC_TEST_SHARDS,
  parseDeterministicShardArgument,
  selectDeterministicTestFiles,
  validateDeterministicTestShards
} from "../scripts/lib/deterministic-test-shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_HEAVY_TEST_FILES = Object.freeze([
  "tests/control-plane_part1.mjs",
  "tests/control-plane_part2.mjs",
  "tests/control-plane_part3.mjs",
  "tests/runtime.test.mjs",
  "tests/test-temp-cleanup.test.mjs",
  "tests/worker-broker-evidence_part1.mjs",
  "tests/worker-broker-evidence_part2.mjs",
  "tests/worker-broker-evidence_part3.mjs",
  "tests/worker-broker-evidence_part4.mjs",
  "tests/worker-broker-evidence_part5.mjs",
  "tests/worker-broker-evidence_part6.mjs",
  "tests/worker-broker-evidence_part7.mjs",
  "tests/worker-broker-evidence_part8.mjs",
  "tests/worker-broker-evidence_part9.mjs",
  "tests/worker-mutation_part1.mjs",
  "tests/worker-mutation_part2.mjs"
]);

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

test("deterministic partition harnesses replace only their ordinary aggregate files", () => {
  assert.deepEqual(DETERMINISTIC_AGGREGATE_TEST_FILES, [
    "tests/control-plane.test.mjs",
    "tests/worker-broker-evidence.test.mjs",
    "tests/worker-mutation.test.mjs"
  ]);
  assert.deepEqual(DETERMINISTIC_SUPPORT_TEST_FILES, [
    "tests/control-plane_part1.mjs",
    "tests/control-plane_part2.mjs",
    "tests/control-plane_part3.mjs",
    "tests/worker-broker-evidence_part1.mjs",
    "tests/worker-broker-evidence_part2.mjs",
    "tests/worker-broker-evidence_part3.mjs",
    "tests/worker-broker-evidence_part4.mjs",
    "tests/worker-broker-evidence_part5.mjs",
    "tests/worker-broker-evidence_part6.mjs",
    "tests/worker-broker-evidence_part7.mjs",
    "tests/worker-broker-evidence_part8.mjs",
    "tests/worker-broker-evidence_part9.mjs",
    "tests/worker-mutation_part1.mjs",
    "tests/worker-mutation_part2.mjs"
  ]);
  const ordinary = fs.readdirSync(path.join(ROOT, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `tests/${name}`);
  for (const aggregateFile of DETERMINISTIC_AGGREGATE_TEST_FILES) {
    assert.equal(ordinary.includes(aggregateFile), true);
    assert.equal(listDeterministicTestFiles().includes(aggregateFile), false);
  }
  for (const supportFile of DETERMINISTIC_SUPPORT_TEST_FILES) {
    assert.equal(ordinary.includes(supportFile), false);
    assert.equal(listDeterministicTestFiles().filter(
      (file) => file === supportFile
    ).length, 1);
  }
});

test("process-heavy cleanup and evidence files are distributed across all shards", () => {
  const heavyCounts = DETERMINISTIC_TEST_SHARDS.map((files) =>
    files.filter((file) => PROCESS_HEAVY_TEST_FILES.includes(file)).length
  );
  assert.deepEqual(heavyCounts, [4, 5, 4, 3]);
});

test("deterministic shard CLI accepts only one exact four-way shard specification", () => {
  assert.equal(parseDeterministicShardArgument([]), null);
  assert.equal(parseDeterministicShardArgument(["--shard=1/4"]), 1);
  assert.equal(parseDeterministicShardArgument(["--shard=2/4"]), 2);
  assert.equal(parseDeterministicShardArgument(["--shard=3/4"]), 3);
  assert.equal(parseDeterministicShardArgument(["--shard=4/4"]), 4);

  const invalid = [
    ["--shard=0/4"],
    ["--shard=5/4"],
    ["--shard=1/3"],
    ["--shard=01/4"],
    ["--shard", "1/4"],
    ["--shard=1/4", "--shard=2/4"],
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
  assert.throws(() => selectDeterministicTestFiles({ inventory, shard: 5 }), Error);
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
  empty[3] = [];
  assert.ok(validateDeterministicTestShards({ inventory, shards: empty })
    .some((message) => /nonempty array/u.test(message)));
});

test("hosted CI contract rejects matrix and gate mutations that could hide coverage failures", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(validateHostedCiWorkflow(workflow), []);
  assert.deepEqual(validateHostedCiWorkflow(workflow.replace(/\n/gu, "\r\n")), []);
  const mutateJob = (jobId, before, after) => {
    const marker = `  ${jobId}:\n`;
    const start = workflow.indexOf(marker);
    assert.notEqual(start, -1);
    const bodyStart = start + marker.length;
    const next = /^  [a-z0-9][a-z0-9-]*:\s*$/mu.exec(workflow.slice(bodyStart));
    const end = next == null ? workflow.length : bodyStart + next.index;
    const job = workflow.slice(start, end);
    const mutatedJob = typeof before === "function"
      ? before(job)
      : job.replace(before, after);
    assert.notEqual(mutatedJob, job);
    return workflow.slice(0, start) + mutatedJob + workflow.slice(end);
  };

  const mutations = [
    workflow.replace(
      "        shard: [1, 2, 3, 4]",
      "        shard: [1, 2, 3, 4]\n        exclude:\n          - os: macos-latest\n            node: 18.18.2\n            shard: 4"
    ),
    workflow.replace(
      "        shard: [1, 2, 3, 4]",
      "        shard: [1, 2, 3, 4]\n        architecture: [x64, arm64]"
    ),
    workflow.replace(
      "        shard: [1, 2, 3, 4]",
      "        shard: [1, 2, 3, 4]\n        \"architecture\": [x64, arm64]"
    ),
    workflow.replace(
      "        shard: [1, 2, 3, 4]",
      "        shard: [1, 2, 3, 4]\n        <<: *extra"
    ),
    mutateJob(
      "pty-ingress",
      "    runs-on: ${{ matrix.os }}",
      "    runs-on: self-hosted\n    # runs-on: ${{ matrix.os }}"
    ),
    mutateJob(
      "pty-ingress",
      "    timeout-minutes: 10",
      "    timeout-minutes: 1\n    # timeout-minutes: 10"
    ),
    mutateJob(
      "pty-ingress",
      "      fail-fast: false",
      "      fail-fast: true\n      # fail-fast: false"
    ),
    mutateJob(
      "validate-and-test",
      "    runs-on: ${{ matrix.os }}",
      "    runs-on: self-hosted\n    # runs-on: ${{ matrix.os }}"
    ),
    mutateJob(
      "validate-and-test",
      "      fail-fast: false",
      "      fail-fast: true\n      # fail-fast: false"
    ),
    mutateJob(
      "validate-and-test",
      "    timeout-minutes: 30",
      "    timeout-minutes: 30\n    \"continue-on-error\": true"
    ),
    mutateJob(
      "validate-and-test",
      "    timeout-minutes: 30",
      "    timeout-minutes: 30\n    \"continue\\u002don\\u002derror\": true"
    ),
    mutateJob(
      "validate-and-test",
      "    timeout-minutes: 30",
      "    timeout-minutes: 30\n    !!str continue-on-error: true"
    ),
    mutateJob(
      "validate-and-test",
      "    timeout-minutes: 30",
      "    timeout-minutes: 30\n    ? continue-on-error\n    : true"
    ),
    mutateJob("validate-and-test", (job) => {
      const canonicalStrategy = [
        "    strategy:",
        "      fail-fast: false",
        "      matrix:",
        "        os: [ubuntu-latest, macos-latest]",
        "        node: [18.18.2, 22.x]",
        "        shard: [1, 2, 3, 4]"
      ].join("\n");
      const fakeName = [
        "    name: |",
        "      strategy:",
        "      fail-fast: false",
        "      matrix:",
        "        os: [ubuntu-latest, macos-latest]",
        "        node: [18.18.2, 22.x]",
        "        shard: [1, 2, 3, 4]"
      ].join("\n");
      const unsafeStrategy = [
        "    strategy:",
        "      fail-fast: true",
        "      matrix:",
        "        os: [ubuntu-latest]",
        "        node: [22.x]",
        "        shard: [1]"
      ].join("\n");
      return `${job
        .replace(
          "    name: ${{ matrix.os }} / Node ${{ matrix.node }} / shard ${{ matrix.shard }}/4\n",
          ""
        )
        .replace(canonicalStrategy, fakeName)
        .trimEnd()}\n${unsafeStrategy}\n`;
    }),
    mutateJob("validate-and-test", (job) => `${job
      .replace(
        "      - name: Run deterministic zero-skip shard\n",
        "      - name: Suppressed deterministic shard\n        if: false\n"
      )
      .trimEnd()}
    environment: |
      - name: Run deterministic zero-skip shard
        run: npm run test:deterministic -- --shard=\${{ matrix.shard }}/4
`),
    mutateJob(
      "windows-neutral",
      "    runs-on: windows-latest",
      "    runs-on: self-hosted\n    # runs-on: windows-latest"
    ),
    mutateJob(
      "windows-neutral",
      "    timeout-minutes: 45",
      "    timeout-minutes: 1\n    # timeout-minutes: 45"
    ),
    mutateJob(
      "windows-neutral",
      "      fail-fast: false",
      "      fail-fast: true\n      # fail-fast: false"
    ),
    workflow.replace(
      "    timeout-minutes: 30",
      "    timeout-minutes: 30\n    continue-on-error: true"
    ),
    workflow.replace("    timeout-minutes: 30", "    timeout-minutes: 20"),
    workflow.replace(
      "    timeout-minutes: 30",
      "    timeout-minutes: 20\n    # timeout-minutes: 30"
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
      "      - name: Run deterministic zero-skip shard",
      "      - name: Run deterministic zero-skip shard\n        \"if\": false"
    ),
    workflow.replace(
      "      - name: Run deterministic zero-skip shard",
      "      - name: Run deterministic zero-skip shard\n        'if': false"
    ),
    workflow.replace(
      "      - name: Run deterministic zero-skip shard",
      "      - name: Run deterministic zero-skip shard\n        \"continue-on-error\": true"
    ),
    workflow.replace(
      "      - name: Run deterministic zero-skip shard",
      "      - name: Run deterministic zero-skip shard\n        \"shell\": bash {0} || true"
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
      "        run: npm run test:deterministic -- --shard=${{ matrix.shard }}/4",
      "        run: npm run test:deterministic -- --shard=${{ matrix.shard }}/3"
    ),
    workflow.replace(
      "        run: npm run test:deterministic -- --shard=${{ matrix.shard }}/4",
      "        shell: bash {0} || true\n        run: npm run test:deterministic -- --shard=${{ matrix.shard }}/4"
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
