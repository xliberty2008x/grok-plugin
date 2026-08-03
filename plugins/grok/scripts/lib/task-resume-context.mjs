import fs from "node:fs";

import { CompanionError } from "./errors.mjs";
import { assertContextCompatible } from "./task-context-manifest.mjs";

/** Bind explicit and implicit resume to the same last authoritative context. */
export function assertResumeSourceContext(root, prior) {
  if (prior.verificationContextManifest || prior.completionContextManifest) {
    assertContextCompatible(
      root,
      prior.verificationContextManifest || prior.completionContextManifest,
      { mode: "resume" }
    );
  } else if (prior.request?.contextManifest) {
    if (Number(prior.schemaVersion || 0) >= 3) {
      throw new CompanionError(
        "E_CONTEXT_DRIFT",
        `Job ${prior.id} is missing its completion context; refusing an unverifiable resume.`
      );
    }
    assertContextCompatible(root, prior.request.contextManifest, { mode: "legacy-resume" });
  } else if (prior.workspaceRoot && fs.realpathSync(root) !== fs.realpathSync(prior.workspaceRoot)) {
    throw new CompanionError(
      "E_CONTEXT_DRIFT",
      "Workspace identity drifted; refusing to resume in a different checkout.",
      {
        code: "E_CONTEXT_DRIFT",
        reasons: ["workspaceRoot"],
        expected: { workspaceRoot: prior.workspaceRoot },
        current: { workspaceRoot: fs.realpathSync(root) }
      }
    );
  }
  return prior;
}
