import { CompanionError } from "./errors.mjs";
import { composeEffectiveProviderPrompt } from "./worker-context.mjs";

/**
 * Compose the provider prompt from a TaskEnvelope without putting envelope JSON on argv.
 */
export function composeProviderPrompt(envelope, {
  root,
  constraints = null,
  contextManifest = null,
  contextPacket = null,
  runtimeRolePolicy = null
} = {}) {
  if (contextPacket !== null || runtimeRolePolicy !== null) {
    if (constraints !== null || contextPacket === null || runtimeRolePolicy === null) {
      throw new CompanionError(
        "E_STATE",
        "Receipt-backed provider prompt requires one packet/policy pair and no prompt override."
      );
    }
    return composeEffectiveProviderPrompt({
      envelope,
      contextPacket,
      rolePolicy: runtimeRolePolicy,
      contextManifest,
      root
    });
  }
  const context = envelope.context || { facts: [], constraints: [], expectedProjectMarkers: [], requiredPaths: [], workspaceState: "unknown", upstreamFreshness: "not_checked" };
  const facts = Array.isArray(context.facts) ? context.facts : [];
  const hostConstraints = Array.isArray(context.constraints) ? context.constraints : [];
  const manifestSummary = contextManifest
    ? [
        `workspace=${contextManifest.workspaceRoot}`,
        `branch=${contextManifest.git?.branch || "detached/unknown"}`,
        `head=${contextManifest.git?.head || "unknown"}`,
        `dirtyPaths=${contextManifest.git?.dirtyPaths?.length || 0}`,
        `sparse=${Boolean(contextManifest.git?.sparse)}`,
        `shallow=${Boolean(contextManifest.git?.shallow)}`,
        `materialization=${contextManifest.materialization?.state || "unknown"}`,
        `projectMarkers=${contextManifest.projectMarkers?.join(",") || "none"}`,
        `upstream=${contextManifest.git?.upstreamRef || "none"}`,
        `upstreamFreshness=${context.upstreamFreshness || "not_checked"}`
      ].join("; ")
    : "unavailable";
  const lines = [
    `User request (literal):\n${envelope.userRequest}`,
    `Objective:\n${envelope.objective}`,
    `Mode: ${envelope.mode}`,
    `Scope include: ${envelope.scope.include.join(", ") || "(none)"}`,
    `Scope exclude: ${envelope.scope.exclude.join(", ") || "(none)"}`,
    `Relevant context facts:\n${facts.length ? facts.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Required context paths verified by host/runtime:\n${context.requiredPaths?.length ? context.requiredPaths.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Host constraints:\n${hostConstraints.length ? hostConstraints.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Non-goals:\n${envelope.nonGoals.length ? envelope.nonGoals.map((item) => `- ${item}`).join("\n") : "(none)"}`,
    `Acceptance criteria:\n${envelope.acceptanceCriteria.map((item) => `- ${item.id}: ${item.text}`).join("\n")}`,
    `Host-owned verification after your return:\n${envelope.requiredVerification.length ? envelope.requiredVerification.map((item) => `- ${item}`).join("\n") : "(host will choose authoritative checks; claim only evidence your available tools actually produced)"}`,
    `Expected return format:\n${envelope.expectedReturnFormat}\nReturn the Worker Report object as the final response through the runtime's native structured-output channel. Do not prefix native JSON with GROK_WORKER_REPORT:. Only if native structured output is unavailable, use GROK_WORKER_REPORT: followed by the object. Do not put progress prose after the final object.`,
    `Context-manifest identity: ${envelope.contextManifestId || "unbound"}`,
    `Context-manifest summary: ${manifestSummary}`
  ];
  const base = lines.join("\n\n");
  const tail = constraints
    || `Grok Companion constraints: do not invoke Grok Companion recursively; do not spawn subagents or use web tools; stay within ${root}; report exactly what you changed and tested.`;
  return `${base}\n\n${tail}`;
}
