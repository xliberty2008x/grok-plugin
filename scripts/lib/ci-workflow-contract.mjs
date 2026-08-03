function workflowJob(source, jobId) {
  const marker = `  ${jobId}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = start + marker.length;
  const nextJob = /^  [a-z0-9][a-z0-9-]*:\s*$/imu.exec(source.slice(bodyStart));
  const end = nextJob ? bodyStart + nextJob.index : source.length;
  return source.slice(start, end);
}

function containsContinueOnError(job) {
  return /^\s+(?:"continue-on-error"|'continue-on-error'|continue-on-error)\s*:/imu.test(job);
}

function hasExactJobLevelFields(job, expectedLines) {
  const actualLines = job
    .split("\n")
    .filter((line) => /^    \S/u.test(line) && !line.trimStart().startsWith("#"));
  return JSON.stringify(actualLines) === JSON.stringify(expectedLines);
}

function workflowMatrix(job) {
  const lines = job.split("\n");
  const strategyIndexes = [];
  const stepsIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "    strategy:") strategyIndexes.push(index);
    if (lines[index] === "    steps:") stepsIndexes.push(index);
  }
  if (
    strategyIndexes.length !== 1
    || stepsIndexes.length !== 1
    || strategyIndexes[0] >= stepsIndexes[0]
    || lines[strategyIndexes[0] + 1] !== "      fail-fast: false"
    || lines[strategyIndexes[0] + 2] !== "      matrix:"
  ) {
    return null;
  }
  return lines
    .slice(strategyIndexes[0] + 3, stepsIndexes[0])
    .join("\n")
    .trimEnd();
}

function workflowStep(job, stepName) {
  const stepsMarker = "\n    steps:\n";
  const stepsStart = job.indexOf(stepsMarker);
  if (
    stepsStart < 0
    || job.indexOf(stepsMarker, stepsStart + stepsMarker.length) >= 0
  ) {
    return null;
  }
  const remainder = job.slice(stepsStart + stepsMarker.length);
  const nextJobField = /^    \S.*$/mu.exec(remainder);
  const steps = nextJobField == null
    ? remainder
    : remainder.slice(0, nextJobField.index);
  const marker = `      - name: ${stepName}\n`;
  const start = steps.indexOf(marker);
  if (start < 0) return null;
  if (steps.indexOf(marker, start + marker.length) >= 0) return null;
  const bodyStart = start + marker.length;
  const nextStep = /^      - name:\s+/imu.exec(steps.slice(bodyStart));
  const end = nextStep ? bodyStart + nextStep.index : steps.length;
  return steps.slice(start, end);
}

function isExactMatrix(matrix, expectedLines) {
  return typeof matrix === "string"
    && matrix === expectedLines.join("\n");
}

function isUnconditionalRunStep(step, command) {
  if (step == null) return false;
  const lines = step
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  return lines.length === 2
    && /^      - name:\s+\S/u.test(lines[0])
    && new RegExp(`^\\s{8}run:\\s*${command}\\s*$`, "u").test(lines[1]);
}

function isShardOneValidationStep(step) {
  return step?.trimEnd() === [
    "      - name: Validate release structure",
    "        if: matrix.shard == 1",
    "        run: node scripts/validate.mjs"
  ].join("\n");
}

function isShardOneHistoryStep(step) {
  return step?.trimEnd() === [
    "      - name: Validate immutable release history",
    "        if: matrix.shard == 1",
    "        run: node scripts/check-release-history.mjs"
  ].join("\n");
}

function isFullHistoryCheckoutStep(step, name) {
  return step?.trimEnd() === [
    `      - name: ${name}`,
    "        uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    "          fetch-tags: true"
  ].join("\n");
}

function hasExactOrderedSteps(job, names) {
  const starts = job
    .split("\n")
    .filter((line) => /^      - /u.test(line));
  return JSON.stringify(starts) === JSON.stringify(
    names.map((name) => `      - name: ${name}`)
  );
}

function normalizedStepLines(step) {
  if (step == null) return [];
  return step
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

function isExactStep(step, lines) {
  return JSON.stringify(normalizedStepLines(step)) === JSON.stringify(lines);
}

function isExactCheckoutStep(step, name = "Check out repository") {
  return isExactStep(step, [
    `      - name: ${name}`,
    "        uses: actions/checkout@v4"
  ]);
}

function isExactNodeSetupStep(step, nodeVersion) {
  return step?.trimEnd() === [
    "      - name: Set up Node.js",
    "        uses: actions/setup-node@v4",
    "        with:",
    `          node-version: ${nodeVersion}`,
    "          cache: npm"
  ].join("\n");
}

function isExactReleaseTagRunStep(step) {
  return isExactStep(step, [
    "      - name: Verify annotated version tag on exact main",
    "        run: node scripts/check-release-tag.mjs \"$GITHUB_REF_NAME\" --require-ref --main-ref origin/main"
  ]);
}

function workflowJobIds(source) {
  const jobsMarker = "\njobs:\n";
  const start = source.indexOf(jobsMarker);
  if (start < 0) return [];
  return source
    .slice(start + jobsMarker.length)
    .split("\n")
    .filter((line) => /^  \S/u.test(line) && !line.trimStart().startsWith("#"))
    .map((line) => line.match(/^  (?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:/u))
    .filter(Boolean)
    .map((match) => match[1] || match[2] || match[3].trim());
}

function workflowTopLevelKeys(source) {
  return source
    .split("\n")
    .filter((line) => /^\S/u.test(line) && !line.startsWith("#"))
    .map((line) => line.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z][A-Za-z0-9_-]*))\s*:/u))
    .filter(Boolean)
    .map((match) => match[1] || match[2] || match[3]);
}

export function validateHostedCiWorkflow(source, { shardCount = 4 } = {}) {
  source = source.replace(/\r\n?/gu, "\n");
  const errors = [];
  const expectedHeader = [
    "name: CI",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "    tags: [\"v*\"]",
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: ci-${{ github.workflow }}-${{ github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:"
  ].join("\n");
  if (!source.startsWith(`${expectedHeader}\n`)) {
    errors.push("CI must preserve the exact safe triggers, read-only permissions, concurrency, and absence of workflow-level defaults or environment hooks.");
  }
  if (JSON.stringify(workflowTopLevelKeys(source)) !== JSON.stringify([
    "name",
    "on",
    "permissions",
    "concurrency",
    "jobs"
  ])) {
    errors.push("CI must not add, duplicate, quote, or reorder workflow-level keys outside the exact reviewed header.");
  }
  const expectedJobIds = [
    "pty-ingress",
    "validate-and-test",
    "windows-neutral",
    "release-tag",
    "installed-codex",
    "natural-codex-grok",
    "ci-required"
  ];
  if (JSON.stringify(workflowJobIds(source)) !== JSON.stringify(expectedJobIds)) {
    errors.push("CI must preserve the exact reviewed job inventory and order.");
  }

  const ptyJob = workflowJob(source, "pty-ingress");
  const ptyMatrix = ptyJob == null ? "" : workflowMatrix(ptyJob);
  const ptyCheckout = ptyJob == null ? null : workflowStep(ptyJob, "Check out repository");
  const ptySetup = ptyJob == null ? null : workflowStep(ptyJob, "Set up Node.js");
  const ptyInstall = ptyJob == null ? null : workflowStep(ptyJob, "Install locked dependencies");
  const ptyRun = ptyJob == null
    ? null
    : workflowStep(ptyJob, "Run source PTY ingress regression");
  if (ptyJob == null
    || containsContinueOnError(ptyJob)
    || !hasExactJobLevelFields(ptyJob, [
      "    name: PTY ingress / ${{ matrix.os }}",
      "    runs-on: ${{ matrix.os }}",
      "    timeout-minutes: 10",
      "    strategy:",
      "    steps:"
    ])
    || !/^    runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}\s*$/mu.test(ptyJob)
    || !/^    timeout-minutes:\s*10\s*$/mu.test(ptyJob)
    || !/^      fail-fast:\s*false\s*$/mu.test(ptyJob)
    || !isExactMatrix(ptyMatrix, [
      "        os: [ubuntu-latest, macos-latest]"
    ])
    || !hasExactOrderedSteps(ptyJob, [
      "Check out repository",
      "Set up Node.js",
      "Install locked dependencies",
      "Run source PTY ingress regression"
    ])
    || !isExactCheckoutStep(ptyCheckout)
    || !isExactNodeSetupStep(ptySetup, "22.x")
    || !isUnconditionalRunStep(ptyInstall, "npm ci --ignore-scripts")
    || !isUnconditionalRunStep(ptyRun, "node --test tests/pty-ingress\.test\.mjs")) {
    errors.push("CI must preserve both fail-closed hosted PTY ingress gates.");
  }

  const unixJob = workflowJob(source, "validate-and-test");
  if (unixJob == null) {
    errors.push("CI must define the sharded Unix deterministic matrix.");
  } else {
    const matrix = workflowMatrix(unixJob);
    const checkout = workflowStep(unixJob, "Check out repository");
    const setupNode = workflowStep(unixJob, "Set up Node.js");
    const install = workflowStep(unixJob, "Install locked dependencies");
    const validationRun = workflowStep(unixJob, "Validate release structure");
    const historyRun = workflowStep(unixJob, "Validate immutable release history");
    const deterministicRun = workflowStep(unixJob, "Run deterministic zero-skip shard");
    if (!hasExactJobLevelFields(unixJob, [
      `    name: \${{ matrix.os }} / Node \${{ matrix.node }} / shard \${{ matrix.shard }}/${shardCount}`,
      "    runs-on: ${{ matrix.os }}",
      "    timeout-minutes: 30",
      "    strategy:",
      "    steps:"
    ])
      || !/^    runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}\s*$/mu.test(unixJob)
      || !/^    timeout-minutes:\s*30\s*$/mu.test(unixJob)
      || !/^      fail-fast:\s*false\s*$/mu.test(unixJob)
      || containsContinueOnError(unixJob)
      || /windows-latest/u.test(matrix)
      || !isExactMatrix(matrix, [
        "        os: [ubuntu-latest, macos-latest]",
        "        node: [18.18.2, 22.x]",
        `        shard: [${Array.from(
          { length: shardCount },
          (_, index) => index + 1
        ).join(", ")}]`
      ])) {
      errors.push(`The Unix deterministic matrix must remain OS x Node x ${shardCount} exact shards with a 30-minute budget and fail-fast disabled.`);
    }
    if (!hasExactOrderedSteps(unixJob, [
      "Check out repository",
      "Set up Node.js",
      "Install locked dependencies",
      "Validate release structure",
      "Validate immutable release history",
      "Run deterministic zero-skip shard"
    ])
      || !isExactNodeSetupStep(setupNode, "${{ matrix.node }}")
      || !isUnconditionalRunStep(install, "npm ci --ignore-scripts")) {
      errors.push("The release-sensitive Unix job must preserve the exact ordered checkout, setup, install, validation, history, and deterministic steps.");
    }
    if (!isShardOneValidationStep(validationRun)) {
      errors.push("Each Unix OS/Node combination must run structural validation only on shard 1.");
    }
    if (!isFullHistoryCheckoutStep(checkout, "Check out repository") || !isShardOneHistoryStep(historyRun)) {
      errors.push("Each Unix OS/Node combination must fetch complete history and preserve immutable release history on shard 1.");
    }
    if (!isUnconditionalRunStep(
      deterministicRun,
      `node scripts/test-deterministic\\.mjs --shard=\\$\\{\\{\\s*matrix\\.shard\\s*\\}\\}/${shardCount}`
    )) {
      errors.push("Each Unix matrix cell must run its exact deterministic shard.");
    }
  }

  const releaseTagJob = workflowJob(source, "release-tag");
  const releaseTagCheckout = releaseTagJob == null
    ? null
    : workflowStep(releaseTagJob, "Check out complete tag and main history");
  const releaseTagSetup = releaseTagJob == null
    ? null
    : workflowStep(releaseTagJob, "Set up Node.js");
  const releaseTagInstall = releaseTagJob == null
    ? null
    : workflowStep(releaseTagJob, "Install locked dependencies");
  const releaseTagRun = releaseTagJob == null
    ? null
    : workflowStep(releaseTagJob, "Verify annotated version tag on exact main");
  if (releaseTagJob == null
    || containsContinueOnError(releaseTagJob)
    || !hasExactJobLevelFields(releaseTagJob, [
      "    name: Release tag required",
      "    if: startsWith(github.ref, 'refs/tags/v')",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 10",
      "    steps:"
    ])
    || !hasExactOrderedSteps(releaseTagJob, [
      "Check out complete tag and main history",
      "Set up Node.js",
      "Install locked dependencies",
      "Verify annotated version tag on exact main"
    ])
    || !isFullHistoryCheckoutStep(releaseTagCheckout, "Check out complete tag and main history")
    || !isExactNodeSetupStep(releaseTagSetup, "22.x")
    || !isUnconditionalRunStep(releaseTagInstall, "npm ci --ignore-scripts")
    || !isExactReleaseTagRunStep(releaseTagRun)) {
    errors.push("Version tags must run the fail-closed annotated-tag gate on the exact fetched main commit.");
  }

  const windowsJob = workflowJob(source, "windows-neutral");
  const windowsMatrix = windowsJob == null ? "" : workflowMatrix(windowsJob);
  const windowsCheckout = windowsJob == null ? null : workflowStep(windowsJob, "Check out repository");
  const windowsSetup = windowsJob == null ? null : workflowStep(windowsJob, "Set up Node.js");
  const windowsInstall = windowsJob == null ? null : workflowStep(windowsJob, "Install locked dependencies");
  const windowsValidate = windowsJob == null
    ? null
    : workflowStep(windowsJob, "Validate release structure");
  const windowsRun = windowsJob == null
    ? null
    : workflowStep(windowsJob, "Run provider-neutral tests (Windows; provider unverified)");
  if (windowsJob == null
    || containsContinueOnError(windowsJob)
    || !hasExactJobLevelFields(windowsJob, [
      "    name: windows-latest / Node ${{ matrix.node }}",
      "    runs-on: windows-latest",
      "    timeout-minutes: 45",
      "    strategy:",
      "    steps:"
    ])
    || !/^    runs-on:\s*windows-latest\s*$/mu.test(windowsJob)
    || !/^    timeout-minutes:\s*45\s*$/mu.test(windowsJob)
    || !/^      fail-fast:\s*false\s*$/mu.test(windowsJob)
    || !isExactMatrix(windowsMatrix, [
      "        node: [18.18.2, 22.x]"
    ])
    || !hasExactOrderedSteps(windowsJob, [
      "Check out repository",
      "Set up Node.js",
      "Install locked dependencies",
      "Validate release structure",
      "Run provider-neutral tests (Windows; provider unverified)"
    ])
    || !isExactCheckoutStep(windowsCheckout)
    || !isExactNodeSetupStep(windowsSetup, "${{ matrix.node }}")
    || !isUnconditionalRunStep(windowsInstall, "npm ci --ignore-scripts")
    || !isUnconditionalRunStep(windowsValidate, "node scripts/validate\.mjs")
    || !isUnconditionalRunStep(windowsRun, "node --test tests/windows-neutral\\.test\\.mjs")) {
    errors.push("CI must preserve both fail-closed Windows Node validation and provider-neutral lanes.");
  }

  const installedJob = workflowJob(source, "installed-codex");
  const installedCheckout = installedJob == null ? null : workflowStep(installedJob, "Check out repository");
  const installedSetup = installedJob == null ? null : workflowStep(installedJob, "Set up Node.js");
  const installedDependencies = installedJob == null ? null : workflowStep(installedJob, "Install locked dependencies");
  const installedRun = installedJob == null
    ? null
    : workflowStep(installedJob, "Require clean Codex marketplace install and cached PTY execution");
  const installedIf = [
    "    if: >-",
    "      ${{ vars.CODEX_PLUGIN_RUNNER_ENABLED == 'true' &&",
    "          (github.event_name == 'workflow_dispatch' ||",
    "           (github.event_name == 'push' && github.ref == 'refs/heads/main')) }}"
  ].join("\n");
  if (installedJob == null
    || containsContinueOnError(installedJob)
    || !hasExactJobLevelFields(installedJob, [
      "    name: Installed Codex snapshot / self-hosted macOS",
      "    if: >-",
      "    runs-on: [self-hosted, macOS, codex-plugin]",
      "    timeout-minutes: 15",
      "    steps:"
    ])
    || !installedJob.includes(installedIf)
    || !hasExactOrderedSteps(installedJob, [
      "Check out repository",
      "Set up Node.js",
      "Install locked dependencies",
      "Require clean Codex marketplace install and cached PTY execution"
    ])
    || !isExactCheckoutStep(installedCheckout)
    || !isExactNodeSetupStep(installedSetup, "22.x")
    || !isUnconditionalRunStep(installedDependencies, "npm ci --ignore-scripts")
    || !isExactStep(installedRun, [
      "      - name: Require clean Codex marketplace install and cached PTY execution",
      "        env:",
      "          CODEX_INSTALL_E2E_REQUIRED: \"1\"",
      "        run: node --test tests/installed-codex.test.mjs"
    ])) {
    errors.push("CI must preserve the exact trusted-main installed Codex snapshot job.");
  }

  const naturalJob = workflowJob(source, "natural-codex-grok");
  const naturalCheckout = naturalJob == null ? null : workflowStep(naturalJob, "Check out repository");
  const naturalSetup = naturalJob == null ? null : workflowStep(naturalJob, "Set up Node.js");
  const naturalDependencies = naturalJob == null ? null : workflowStep(naturalJob, "Install locked dependencies");
  const naturalMarketplace = naturalJob == null ? null : workflowStep(naturalJob, "Point the local marketplace at this checkout");
  const naturalInstall = naturalJob == null ? null : workflowStep(naturalJob, "Verify and install the tested plugin snapshot");
  const naturalRun = naturalJob == null ? null : workflowStep(naturalJob, "Run natural installed Codex to real Grok qualification");
  const naturalIf = [
    "    if: >-",
    "      ${{ vars.CODEX_GROK_NATURAL_E2E_ENABLED == 'true' &&",
    "          (github.event_name == 'workflow_dispatch' ||",
    "           (github.event_name == 'push' && github.ref == 'refs/heads/main')) }}"
  ].join("\n");
  if (naturalJob == null
    || containsContinueOnError(naturalJob)
    || !hasExactJobLevelFields(naturalJob, [
      "    name: Natural Codex + real Grok / self-hosted macOS",
      "    if: >-",
      "    runs-on: [self-hosted, macOS, codex-plugin, grok-authenticated]",
      "    timeout-minutes: 30",
      "    steps:"
    ])
    || !naturalJob.includes(naturalIf)
    || !hasExactOrderedSteps(naturalJob, [
      "Check out repository",
      "Set up Node.js",
      "Install locked dependencies",
      "Point the local marketplace at this checkout",
      "Verify and install the tested plugin snapshot",
      "Run natural installed Codex to real Grok qualification"
    ])
    || !isExactCheckoutStep(naturalCheckout)
    || !isExactNodeSetupStep(naturalSetup, "22.x")
    || !isUnconditionalRunStep(naturalDependencies, "npm ci --ignore-scripts")
    || !isUnconditionalRunStep(naturalMarketplace, "codex plugin marketplace add \"\\$GITHUB_WORKSPACE\" --json")
    || !isUnconditionalRunStep(naturalInstall, "node scripts/update-local-codex\\.mjs")
    || !isExactStep(naturalRun, [
      "      - name: Run natural installed Codex to real Grok qualification",
      "        env:",
      "          CODEX_E2E_MODEL: ${{ vars.CODEX_E2E_MODEL }}",
      "        run: node scripts/test-natural-codex.mjs"
    ])) {
    errors.push("CI must preserve the exact credential-bearing natural Codex and Grok qualification job.");
  }

  const prGate = workflowJob(source, "ci-required");
  const prGateStep = prGate == null ? null : workflowStep(prGate, "Require hosted CI job groups");
  if (prGate == null
    || containsContinueOnError(prGate)
    || !hasExactJobLevelFields(prGate, [
      "    name: CI required",
      "    if: always()",
      "    needs: [pty-ingress, validate-and-test, windows-neutral]",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 5",
      "    steps:"
    ])
    || !hasExactOrderedSteps(prGate, ["Require hosted CI job groups"])
    || !isExactStep(prGateStep, [
      "      - name: Require hosted CI job groups",
      "        env:",
      "          PTY_INGRESS_RESULT: ${{ needs['pty-ingress'].result }}",
      "          DETERMINISTIC_RESULT: ${{ needs['validate-and-test'].result }}",
      "          WINDOWS_RESULT: ${{ needs['windows-neutral'].result }}",
      "        run: |",
      "          if [ \"$PTY_INGRESS_RESULT\" != \"success\" ] ||",
      "             [ \"$DETERMINISTIC_RESULT\" != \"success\" ] ||",
      "             [ \"$WINDOWS_RESULT\" != \"success\" ]; then",
      "            exit 1",
      "          fi"
    ])) {
    errors.push("CI must preserve the stable CI required gate and directly fail on every unsuccessful hosted dependency.");
  }

  return errors;
}
