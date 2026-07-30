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
  return /^\s+continue-on-error\s*:/imu.test(job);
}

function workflowMatrix(job) {
  return /strategy:\s*\n[\s\S]*?matrix:\s*\n([\s\S]*?)\n\s{4}steps:/u.exec(job)?.[1] ?? "";
}

function workflowStep(job, stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = start + marker.length;
  const nextStep = /^      - name:\s+/imu.exec(job.slice(bodyStart));
  const end = nextStep ? bodyStart + nextStep.index : job.length;
  return job.slice(start, end);
}

function isExactMatrix(matrix, checks) {
  return !/^\s*(?:include|exclude)\s*:/imu.test(matrix)
    && checks.every((check) => check.test(matrix));
}

function isUnconditionalRunStep(step, command) {
  return step != null
    && !/^\s+(?:if|continue-on-error|shell)\s*:/imu.test(step)
    && new RegExp(`^\\s{8}run:\\s*${command}\\s*$`, "mu").test(step);
}

function isShardOneValidationStep(step) {
  return step?.trimEnd() === [
    "      - name: Validate release structure",
    "        if: matrix.shard == 1",
    "        run: npm run validate"
  ].join("\n");
}

export function validateHostedCiWorkflow(source, { shardCount = 3 } = {}) {
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
    || !isExactMatrix(ptyMatrix, [
      /os:\s*\[ubuntu-latest,\s*macos-latest\]/u
    ])
    || !isUnconditionalRunStep(ptyRun, "npm run test:pty-ingress")) {
    errors.push("CI must preserve both fail-closed hosted PTY ingress gates.");
  }

  const unixJob = workflowJob(source, "validate-and-test");
  if (unixJob == null) {
    errors.push("CI must define the sharded Unix deterministic matrix.");
  } else {
    const matrix = workflowMatrix(unixJob);
    const validationRun = workflowStep(unixJob, "Validate release structure");
    const deterministicRun = workflowStep(unixJob, "Run deterministic zero-skip shard");
    if (!/runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/u.test(unixJob)
      || !/timeout-minutes:\s*40\b/u.test(unixJob)
      || !/fail-fast:\s*false\b/u.test(unixJob)
      || containsContinueOnError(unixJob)
      || /windows-latest/u.test(matrix)
      || !isExactMatrix(matrix, [
        /os:\s*\[ubuntu-latest,\s*macos-latest\]/u,
        /node:\s*\[18\.18\.2,\s*22\.x\]/u,
        new RegExp(`shard:\\s*\\[${Array.from(
          { length: shardCount },
          (_, index) => index + 1
        ).join(",\\s*")}\\]`, "u")
      ])) {
      errors.push("The Unix deterministic matrix must remain OS x Node x three exact shards with a 40-minute aggregate budget and fail-fast disabled.");
    }
    if (!isShardOneValidationStep(validationRun)) {
      errors.push("Each Unix OS/Node combination must run structural validation only on shard 1.");
    }
    if (!isUnconditionalRunStep(
      deterministicRun,
      "npm run test:deterministic -- --shard=\\$\\{\\{\\s*matrix\\.shard\\s*\\}\\}/3"
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
    || !/runs-on:\s*windows-latest/u.test(windowsJob)
    || !/timeout-minutes:\s*45\b/u.test(windowsJob)
    || !isExactMatrix(windowsMatrix, [
      /node:\s*\[18\.18\.2,\s*22\.x\]/u
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
