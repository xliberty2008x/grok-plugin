#!/usr/bin/env node

import process from "node:process";
import { asErrorPayload, exitCodeFor } from "./lib/errors.mjs";
import { hostCommand } from "./lib/host.mjs";
import { projectWorkerError } from "./lib/worker-protocol.mjs";
import { main } from "./lib/companion-cli.mjs";
import { projectTransferCliError } from "./lib/companion-shared.mjs";
main().catch((error) => {
  const privatePayload = asErrorPayload(error);
  const payload = (
    process.argv[2] === "transfer"
      ? projectTransferCliError(privatePayload)
      : projectWorkerError(privatePayload)
  ) || {
    code: "E_BROKER",
    message: "Worker failed."
  };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: payload }, null, 2)}\n`);
  } else {
    process.stderr.write(`${payload.code}: ${payload.message}\n`);
    if (payload.details?.workerId) {
      process.stderr.write(
        `Job: ${payload.details.workerId}\n`
        + `Check: ${hostCommand("status", payload.details.workerId)}\n`
      );
    }
  }
  process.exitCode = exitCodeFor(error);
});
