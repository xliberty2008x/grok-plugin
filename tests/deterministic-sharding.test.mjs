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
  WORKER_BROKER_EVIDENCE_SEMANTIC_TEST_FILES,
  parseDeterministicShardArgument,
  selectDeterministicTestFiles,
  validateDeterministicTestShards
} from "../scripts/lib/deterministic-test-shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_HEAVY_TEST_FILES = Object.freeze([
  "tests/control-plane-context-manifest.test.mjs",
  "tests/control-plane-git-refs.test.mjs",
  "tests/control-plane-lifecycle.test.mjs",
  "tests/control-plane-metadata-races.test.mjs",
  "tests/control-plane-worker-contracts.test.mjs",
  "tests/runtime-admission.test.mjs",
  "tests/runtime-cancellation.test.mjs",
  "tests/runtime-recovery.test.mjs",
  "tests/runtime-task-lifecycle.test.mjs",
  "tests/runtime-transfer.test.mjs",
  "tests/test-temp-cleanup.test.mjs",
  "tests/worker-broker-evidence-cutover-cli.test.mjs",
  "tests/worker-broker-evidence-deterministic-runner.test.mjs",
  "tests/worker-broker-evidence-immutable-ledger.test.mjs",
  "tests/worker-broker-evidence-live-receipts.test.mjs",
  "tests/worker-broker-evidence-proof-chain.test.mjs",
  "tests/worker-broker-evidence-proof-toolchain.test.mjs",
  "tests/worker-broker-evidence-protected-publication.test.mjs",
  "tests/worker-broker-evidence-review-attestations.test.mjs",
  "tests/worker-broker-evidence-source-records.test.mjs",
  "tests/worker-mutation-cancellation-recovery.test.mjs",
  "tests/worker-mutation-provisioning-adoption.test.mjs",
  "tests/worker-mutation-provisioning-intent.test.mjs",
  "tests/worker-mutation-terminal-evidence.test.mjs"
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
  assert.equal(combined.includes("tests/source-structure-policy.test.mjs"), true);
  assert.ok(EXTERNAL_BOUNDARY_TESTS.every((file) => !combined.includes(`tests/${file}`)));
});

test("deterministic inventory uses ordinary semantic evidence tests without partitions", () => {
  assert.deepEqual(DETERMINISTIC_AGGREGATE_TEST_FILES, [
    "tests/worker-broker-evidence.test.mjs"
  ]);
  assert.deepEqual(DETERMINISTIC_SUPPORT_TEST_FILES, []);
  const inventory = listDeterministicTestFiles();
  assert.ok(WORKER_BROKER_EVIDENCE_SEMANTIC_TEST_FILES.every(
    (file) => inventory.includes(file)
  ));
  assert.equal(inventory.includes(DETERMINISTIC_AGGREGATE_TEST_FILES[0]), false);
  assert.equal(
    fs.readdirSync(path.join(ROOT, "tests")).some((name) => (
      /^worker-broker-evidence_part[0-9]+\.mjs$/u.test(name)
    )),
    false
  );
});

test("process-heavy cleanup and evidence files are distributed across all shards", () => {
  const heavyCounts = DETERMINISTIC_TEST_SHARDS.map((files) =>
    files.filter((file) => PROCESS_HEAVY_TEST_FILES.includes(file)).length
  );
  assert.deepEqual(heavyCounts, [5, 7, 5, 7]);
  assert.ok(heavyCounts.every((count) => count >= 5));
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
      "pty-ingress",
      "      - name: Run source PTY ingress regression",
      "      - run: echo 'NODE_OPTIONS=--require ./mutator.cjs' >> \"$GITHUB_ENV\"\n\n      - name: Run source PTY ingress regression"
    ),
    mutateJob(
      "pty-ingress",
      "      - name: Set up Node.js\n        uses: actions/setup-node@v4",
      "      - name: Set up Node.js\n        run: echo bypass"
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
    mutateJob(
      "validate-and-test",
      "        run: node scripts/check-release-history.mjs",
      "        run: node scripts/validate.mjs --versions-only"
    ),
    mutateJob(
      "validate-and-test",
      "      - name: Validate immutable release history",
      "      - name: Rewrite release refs\n        run: git update-ref refs/remotes/origin/main HEAD\n\n      - name: Validate immutable release history"
    ),
    mutateJob(
      "validate-and-test",
      "      - name: Set up Node.js\n        uses: actions/setup-node@v4",
      "      - name: Set up Node.js\n        run: git update-ref refs/remotes/origin/main HEAD"
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
        run: node scripts/test-deterministic.mjs --shard=\${{ matrix.shard }}/4
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
    mutateJob(
      "windows-neutral",
      "      - name: Run provider-neutral tests (Windows; provider unverified)",
      "      - run: node scripts/mutate-tests.mjs\n\n      - name: Run provider-neutral tests (Windows; provider unverified)"
    ),
    mutateJob(
      "release-tag",
      "    if: startsWith(github.ref, 'refs/tags/v')",
      "    if: false"
    ),
    mutateJob(
      "release-tag",
      "--require-ref --main-ref origin/main",
      "--main-ref origin/main"
    ),
    mutateJob(
      "release-tag",
      "          fetch-depth: 0",
      "          fetch-depth: 1"
    ),
    mutateJob(
      "release-tag",
      "      - name: Verify annotated version tag on exact main",
      "      - name: Rewrite release refs\n        run: git update-ref refs/remotes/origin/main HEAD\n\n      - name: Verify annotated version tag on exact main"
    ),
    mutateJob(
      "release-tag",
      "      - name: Set up Node.js\n        uses: actions/setup-node@v4",
      "      - name: Set up Node.js\n        run: git update-ref refs/remotes/origin/main HEAD"
    ),
    workflow.replace(
      "    timeout-minutes: 30",
      "    timeout-minutes: 30\n    continue-on-error: true"
    ),
    mutateJob(
      "installed-codex",
      "      - name: Require clean Codex marketplace install and cached PTY execution",
      "      - run: node scripts/exfiltrate.cjs\n\n      - name: Require clean Codex marketplace install and cached PTY execution"
    ),
    mutateJob(
      "natural-codex-grok",
      "      - name: Run natural installed Codex to real Grok qualification\n        env:",
      "      - name: Run natural installed Codex to real Grok qualification\n        run: echo bypass\n\n      - name: Duplicate natural qualification\n        env:"
    ),
    mutateJob(
      "ci-required",
      "    timeout-minutes: 5",
      "    timeout-minutes: 5\n    defaults:\n      run:\n        shell: /usr/bin/true {0}"
    ),
    mutateJob(
      "ci-required",
      "      - name: Require hosted CI job groups",
      "      - run: echo bypass\n\n      - name: Require hosted CI job groups"
    ),
    workflow.replace("    timeout-minutes: 30", "    timeout-minutes: 20"),
    workflow.replace(
      "    timeout-minutes: 30",
      "    timeout-minutes: 20\n    # timeout-minutes: 30"
    ),
    workflow.replace(
      "        run: node --test tests/pty-ingress.test.mjs",
      "        continue-on-error: true\n        run: node --test tests/pty-ingress.test.mjs"
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
      "        run: node scripts/test-deterministic.mjs --shard=${{ matrix.shard }}/4",
      "        run: node scripts/test-deterministic.mjs --shard=${{ matrix.shard }}/3"
    ),
    workflow.replace(
      "        run: node scripts/test-deterministic.mjs --shard=${{ matrix.shard }}/4",
      "        shell: bash {0} || true\n        run: node scripts/test-deterministic.mjs --shard=${{ matrix.shard }}/4"
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
      "      - name: Validate release structure\n        run: node scripts/validate.mjs",
      "      - name: Validate release structure\n        if: false\n        run: node scripts/validate.mjs"
    ),
    workflow.replace(
      "        run: |\n          if [ \"$PTY_INGRESS_RESULT\"",
      "        run: |\n          if false; then\n            exit 0\n          fi\n          if [ \"$PTY_INGRESS_RESULT\""
    ),
    workflow.replace("  pull_request:\n", ""),
    workflow.replace(
      "  workflow_dispatch:\n",
      "  workflow_dispatch:\n  pull_request_target:\n"
    ),
    workflow.replace("    branches: [main]\n", "    branches: [release]\n"),
    workflow.replace("    tags: [\"v*\"]\n", ""),
    workflow.replace("  workflow_dispatch:\n", ""),
    workflow.replace(
      "permissions:\n  contents: read",
      "permissions:\n  contents: write"
    ),
    workflow.replace(
      "permissions:\n",
      "defaults:\n  run:\n    shell: ./scripts/wrapper.sh {0}\n\npermissions:\n"
    ),
    workflow.replace(
      "permissions:\n",
      "env:\n  BASH_ENV: ./scripts/mutate-release-refs.sh\n  NODE_OPTIONS: --require ./scripts/mutate-release-refs.cjs\n\npermissions:\n"
    ),
    workflow.replace(
      "  ci-required:\n",
      "  mutate-release-refs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git update-ref refs/remotes/origin/main HEAD\n\n  ci-required:\n"
    ),
    workflow.replace(
      "  ci-required:\n",
      "  _mutator:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bypass\n\n  ci-required:\n"
    ),
    workflow.replace(
      "  ci-required:\n",
      "  \"Mutator_Job\": { runs-on: ubuntu-latest }\n\n  ci-required:\n"
    ),
    `${workflow}\nenv: { BASH_ENV: ./scripts/wrapper.sh }\n`,
    `${workflow}\ndefaults: { run: { shell: \"/usr/bin/true {0}\" } }\n`,
    `${workflow}\npermissions:\n  contents: write\n`
  ];
  for (const mutated of mutations) {
    assert.notDeepEqual(validateHostedCiWorkflow(mutated), [], "mutation must fail closed");
  }
});
