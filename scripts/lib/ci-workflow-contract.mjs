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
    "        run: npm run validate"
  ].join("\n");
}

const HOSTED_MACOS_PULL_REQUEST_SKIP =
  "    if: ${{ github.event_name != 'pull_request' || matrix.os != 'macos-latest' }}";

function skipsHostedMacosOnPullRequest(job) {
  return job.split("\n").includes(HOSTED_MACOS_PULL_REQUEST_SKIP);
}

export function validateHostedCiWorkflow(source, { shardCount = 4 } = {}) {
  source = source.replace(/\r\n?/gu, "\n");
  const errors = [];
  const expectedTriggers = [
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "  workflow_dispatch:"
  ].join("\n");
  if (!source.startsWith(`name: CI\n\n${expectedTriggers}\n`)) {
    errors.push("CI must run on pull requests, main pushes, and manual dispatch.");
  }

  const ptyJob = workflowJob(source, "pty-ingress");
  const ptyMatrix = ptyJob == null ? "" : workflowMatrix(ptyJob);
  const ptyRun = ptyJob == null
    ? null
    : workflowStep(ptyJob, "Run source PTY ingress regression");
  if (ptyJob == null
    || containsContinueOnError(ptyJob)
    || !hasExactJobLevelFields(ptyJob, [
      "    name: PTY ingress / ${{ matrix.os }}",
      HOSTED_MACOS_PULL_REQUEST_SKIP,
      "    runs-on: ${{ matrix.os }}",
      "    timeout-minutes: 10",
      "    strategy:",
      "    steps:"
    ])
    || !skipsHostedMacosOnPullRequest(ptyJob)
    || !/^    runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}\s*$/mu.test(ptyJob)
    || !/^    timeout-minutes:\s*10\s*$/mu.test(ptyJob)
    || !/^      fail-fast:\s*false\s*$/mu.test(ptyJob)
    || !isExactMatrix(ptyMatrix, [
      "        os: [ubuntu-latest, macos-latest]"
    ])
    || !isUnconditionalRunStep(ptyRun, "npm run test:pty-ingress")) {
    errors.push("CI must preserve both fail-closed hosted PTY ingress gates and skip hosted macOS on pull_request.");
  }

  const unixJob = workflowJob(source, "validate-and-test");
  if (unixJob == null) {
    errors.push("CI must define the sharded Unix deterministic matrix.");
  } else {
    const matrix = workflowMatrix(unixJob);
    const validationRun = workflowStep(unixJob, "Validate release structure");
    const deterministicRun = workflowStep(unixJob, "Run deterministic zero-skip shard");
    if (!hasExactJobLevelFields(unixJob, [
      `    name: \${{ matrix.os }} / Node \${{ matrix.node }} / shard \${{ matrix.shard }}/${shardCount}`,
      HOSTED_MACOS_PULL_REQUEST_SKIP,
      "    runs-on: ${{ matrix.os }}",
      "    timeout-minutes: 30",
      "    strategy:",
      "    steps:"
    ])
      || !skipsHostedMacosOnPullRequest(unixJob)
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
      errors.push(`The Unix deterministic matrix must remain OS x Node x ${shardCount} exact shards with a 30-minute budget, fail-fast disabled, and hosted macOS skipped on pull_request.`);
    }
    if (!isShardOneValidationStep(validationRun)) {
      errors.push("Each Unix OS/Node combination must run structural validation only on shard 1.");
    }
    if (!isUnconditionalRunStep(
      deterministicRun,
      `npm run test:deterministic -- --shard=\\$\\{\\{\\s*matrix\\.shard\\s*\\}\\}/${shardCount}`
    )) {
      errors.push("Each Unix matrix cell must run its exact deterministic shard.");
    }
  }

  const windowsJob = workflowJob(source, "windows-neutral");
  const windowsMatrix = windowsJob == null ? "" : workflowMatrix(windowsJob);
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
    || !isUnconditionalRunStep(windowsValidate, "npm run validate")
    || !isUnconditionalRunStep(windowsRun, "node --test tests/windows-neutral\\.test\\.mjs")) {
    errors.push("CI must preserve both fail-closed Windows Node validation and provider-neutral lanes.");
  }

  const prGate = workflowJob(source, "ci-required");
  const exactGate = /run:\s*\|\s*\n\s+if \[ "\$PTY_INGRESS_RESULT" != "success" \] \|\|\s*\n\s+\[ "\$DETERMINISTIC_RESULT" != "success" \] \|\|\s*\n\s+\[ "\$WINDOWS_RESULT" != "success" \]; then\s*\n\s+exit 1\s*\n\s+fi(?:\s*\n|$)/u;
  const exactGateEnvironment = [
    /PTY_INGRESS_RESULT:\s*\$\{\{\s*needs\['pty-ingress'\]\.result\s*\}\}/u,
    /DETERMINISTIC_RESULT:\s*\$\{\{\s*needs\['validate-and-test'\]\.result\s*\}\}/u,
    /WINDOWS_RESULT:\s*\$\{\{\s*needs\['windows-neutral'\]\.result\s*\}\}/u
  ];
  if (prGate == null
    || containsContinueOnError(prGate)
    || !/name:\s*CI required\b/u.test(prGate)
    || !/always\(\)/u.test(prGate)
    || !/needs:\s*\[pty-ingress,\s*validate-and-test,\s*windows-neutral\]/u.test(prGate)
    || !exactGateEnvironment.every((assignment) => assignment.test(prGate))
    || !exactGate.test(prGate)) {
    errors.push("CI must preserve the stable CI required gate and directly fail on every unsuccessful hosted dependency.");
  }

  return errors;
}
