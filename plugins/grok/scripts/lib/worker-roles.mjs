/**
 * Immutable worker roles with digest checks.
 * Workers cannot self-escalate; only the host grants a new profile/role.
 */
import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";

export const WORKER_ROLE_VERSION = 1;

const ROLE_SPECS = Object.freeze({
  explorer: Object.freeze({
    id: "explorer",
    write: false,
    tools: Object.freeze(["read", "search", "list"]),
    description: "Read-only investigation and planning."
  }),
  implementer: Object.freeze({
    id: "implementer",
    write: true,
    tools: Object.freeze(["read", "search", "list", "edit", "test"]),
    description: "Bounded implementation within an isolated execution root."
  }),
  reviewer: Object.freeze({
    id: "reviewer",
    write: false,
    tools: Object.freeze(["read", "search", "list", "review"]),
    description: "Independent review without mutation."
  }),
  security: Object.freeze({
    id: "security",
    write: false,
    tools: Object.freeze(["read", "search", "list", "security-review"]),
    description: "Security-focused analysis without mutation."
  }),
  test: Object.freeze({
    id: "test",
    write: false,
    tools: Object.freeze(["read", "search", "list", "test"]),
    description: "Test authoring guidance and verification planning (read-only by default)."
  })
});

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function listWorkerRoles() {
  return Object.values(ROLE_SPECS).map((spec) => materializeRole(spec.id));
}

export function roleDigest(spec) {
  return crypto.createHash("sha256").update(stableStringify({
    version: WORKER_ROLE_VERSION,
    id: spec.id,
    write: spec.write,
    tools: [...spec.tools]
  })).digest("hex");
}

export function materializeRole(roleId) {
  const spec = ROLE_SPECS[roleId];
  if (!spec) {
    throw new CompanionError("E_ROLE", `Unknown worker role ${roleId}.`);
  }
  return Object.freeze({
    schemaVersion: WORKER_ROLE_VERSION,
    id: spec.id,
    write: spec.write,
    tools: [...spec.tools],
    description: spec.description,
    digest: roleDigest(spec)
  });
}

export function assertRoleDigest(role) {
  if (!role || typeof role !== "object") {
    throw new CompanionError("E_ROLE", "Worker role is required.");
  }
  const expected = materializeRole(role.id);
  if (role.digest !== expected.digest) {
    throw new CompanionError("E_ROLE", "Worker role digest mismatch.", {
      roleId: role.id,
      expectedDigest: expected.digest,
      actualDigest: role.digest || null
    });
  }
  if (Boolean(role.write) !== expected.write) {
    throw new CompanionError("E_ROLE", "Worker role write capability mismatch.");
  }
  return expected;
}

/**
 * Workers may request a host action but cannot grant themselves a wider role.
 */
export function requestHostAction(currentRole, requested) {
  const role = assertRoleDigest(currentRole);
  if (!requested || typeof requested !== "object") {
    throw new CompanionError("E_USAGE", "Host action request must be an object.");
  }
  const kind = String(requested.kind || "").trim();
  if (!kind) throw new CompanionError("E_USAGE", "Host action kind is required.");
  if (kind === "escalate_role" || kind === "widen_tools" || kind === "widen_scope") {
    // Record the request only; never auto-grant.
    return Object.freeze({
      state: "awaiting_host_action",
      kind,
      requestedAt: new Date().toISOString(),
      currentRoleId: role.id,
      requestedRoleId: requested.roleId || null,
      granted: false,
      note: "Only the host may grant a new profile or role."
    });
  }
  return Object.freeze({
    state: "awaiting_host_action",
    kind,
    requestedAt: new Date().toISOString(),
    currentRoleId: role.id,
    granted: false,
    detail: requested.detail || null
  });
}

export function grantHostAction(hostPrincipal, request, grant) {
  if (!hostPrincipal?.hostKind) {
    throw new CompanionError("E_AUTH_REQUIRED", "Host principal required to grant actions.");
  }
  if (!request || request.state !== "awaiting_host_action" || request.granted) {
    throw new CompanionError("E_USAGE", "No pending host action to grant.");
  }
  if (grant?.roleId) {
    const role = materializeRole(grant.roleId);
    return Object.freeze({
      ...request,
      granted: true,
      grantedAt: new Date().toISOString(),
      grantedRole: role
    });
  }
  return Object.freeze({
    ...request,
    granted: true,
    grantedAt: new Date().toISOString(),
    grantDetail: grant || {}
  });
}

export function assertWorkerCannotSelfEscalate(job, nextRoleId) {
  if (!nextRoleId) return;
  const current = job?.role?.id || job?.request?.roleId || null;
  if (current && nextRoleId !== current) {
    throw new CompanionError(
      "E_ROLE",
      "Workers cannot self-escalate roles; host grant required."
    );
  }
}

export { ROLE_SPECS };
