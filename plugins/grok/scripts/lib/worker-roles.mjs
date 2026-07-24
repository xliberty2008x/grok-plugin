/**
 * Immutable worker roles with digest checks.
 * Workers cannot self-escalate; only the host grants a new profile/role.
 */
import crypto from "node:crypto";

import { CompanionError } from "./errors.mjs";

export const WORKER_ROLE_VERSION = 1;
export const RUNTIME_ROLE_POLICY_VERSION = 1;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PROVIDER_PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROVIDER_TOOL_ID = /^[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z0-9][A-Za-z0-9_.*-]{0,127}$/;
const ROLE_KEYS = new Set([
  "schemaVersion",
  "id",
  "write",
  "tools",
  "description",
  "digest"
]);
const RUNTIME_ROLE_POLICY_KEYS = new Set([
  "schemaVersion",
  "logicalRoleId",
  "roleDigest",
  "write",
  "providerProfileId",
  "providerProfileVersion",
  "agentProfileDigest",
  "allowedProviderToolIds",
  "deniedProviderToolIds",
  "digest"
]);

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
    tools: Object.freeze([...spec.tools]),
    description: spec.description,
    digest: roleDigest(spec)
  });
}

export function assertRoleDigest(role) {
  if (!role
    || typeof role !== "object"
    || Array.isArray(role)
    || Object.keys(role).length !== ROLE_KEYS.size
    || Object.keys(role).some((key) => !ROLE_KEYS.has(key))) {
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
  if (typeof role.write !== "boolean" || role.write !== expected.write) {
    throw new CompanionError("E_ROLE", "Worker role write capability mismatch.");
  }
  if (
    role.schemaVersion !== expected.schemaVersion
    || role.description !== expected.description
    || !Array.isArray(role.tools)
    || role.tools.length !== expected.tools.length
    || role.tools.some((tool, index) => tool !== expected.tools[index])
  ) {
    throw new CompanionError("E_ROLE", "Worker role capability set mismatch.");
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
  void hostPrincipal;
  void request;
  void grant;
  // A plain JavaScript object is not a host attestation. Keep the grant side
  // fail-closed until the broker supplies a non-forgeable, worker-bound host
  // authorization primitive. Requests may still be recorded for presentation.
  throw new CompanionError(
    "E_CAPABILITY",
    "Host action grants are disabled until trusted broker-bound host attestation is available."
  );
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

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function policyDigest(body) {
  return crypto.createHash("sha256").update(stableStringify(body)).digest("hex");
}

function exactProviderToolList(value) {
  if (!Array.isArray(value)
    || value.length > 64
    || value.some((item) => typeof item !== "string" || !PROVIDER_TOOL_ID.test(item))
    || new Set(value).size !== value.length) return null;
  return value.slice();
}

/**
 * Build an immutable RuntimeRolePolicy binding a logical role to the exact
 * provider profile id/version/agent digest and allowed/denied provider tool ids.
 * Root public spawn only advertises explorer; other roles remain internal.
 */
export function buildRuntimeRolePolicy({
  role,
  profile,
  logicalRoleId = role?.id
} = {}) {
  const expectedRole = assertRoleDigest(role || materializeRole(logicalRoleId));
  if (logicalRoleId && logicalRoleId !== expectedRole.id) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy logical role does not match the materialised role.");
  }
  if (!profile || typeof profile !== "object") {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy requires a provider security profile.");
  }
  if (typeof profile.id !== "string" || !PROVIDER_PROFILE_ID.test(profile.id)) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy requires a provider profile id.");
  }
  if (!Number.isSafeInteger(profile.contractVersion) || profile.contractVersion < 1) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy requires a provider profile contract version.");
  }
  if (!SHA256_HEX.test(profile.agentProfileDigest || "")) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy requires an exact agent profile digest.");
  }
  const allowed = exactProviderToolList(profile.providerToolIds);
  const denied = exactProviderToolList(profile.deniedProviderToolIds);
  if (!allowed || !denied) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy requires exact allowed and denied provider tool ids.");
  }
  const body = {
    schemaVersion: RUNTIME_ROLE_POLICY_VERSION,
    logicalRoleId: expectedRole.id,
    roleDigest: expectedRole.digest,
    write: expectedRole.write,
    providerProfileId: profile.id,
    providerProfileVersion: profile.contractVersion,
    agentProfileDigest: profile.agentProfileDigest,
    allowedProviderToolIds: allowed,
    deniedProviderToolIds: denied
  };
  return deepFreeze({
    ...body,
    digest: policyDigest(body)
  });
}

export function assertRuntimeRolePolicy(policy, { role = null, profile = null } = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy is missing or malformed.");
  }
  if (Object.keys(policy).length !== RUNTIME_ROLE_POLICY_KEYS.size
    || Object.keys(policy).some((key) => !RUNTIME_ROLE_POLICY_KEYS.has(key))
    || policy.schemaVersion !== RUNTIME_ROLE_POLICY_VERSION) {
    throw new CompanionError("E_ROLE", "Unsupported RuntimeRolePolicy schema version.");
  }
  if (!SHA256_HEX.test(policy.digest || "")
    || !SHA256_HEX.test(policy.roleDigest || "")
    || !SHA256_HEX.test(policy.agentProfileDigest || "")) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy digests are malformed.");
  }
  const allowedPolicyTools = exactProviderToolList(policy.allowedProviderToolIds);
  const deniedPolicyTools = exactProviderToolList(policy.deniedProviderToolIds);
  if (!allowedPolicyTools
    || !deniedPolicyTools
    || typeof policy.logicalRoleId !== "string"
    || !ROLE_SPECS[policy.logicalRoleId]
    || typeof policy.write !== "boolean"
    || typeof policy.providerProfileId !== "string"
    || !PROVIDER_PROFILE_ID.test(policy.providerProfileId)
    || !Number.isSafeInteger(policy.providerProfileVersion)
    || policy.providerProfileVersion < 1) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy tool ids are malformed.");
  }
  const body = {
    schemaVersion: policy.schemaVersion,
    logicalRoleId: policy.logicalRoleId,
    roleDigest: policy.roleDigest,
    write: policy.write,
    providerProfileId: policy.providerProfileId,
    providerProfileVersion: policy.providerProfileVersion,
    agentProfileDigest: policy.agentProfileDigest,
    allowedProviderToolIds: allowedPolicyTools,
    deniedProviderToolIds: deniedPolicyTools
  };
  if (policy.digest !== policyDigest(body)) {
    throw new CompanionError("E_ROLE", "RuntimeRolePolicy digest mismatch.");
  }
  if (role) {
    const expectedRole = assertRoleDigest(role);
    if (expectedRole.id !== policy.logicalRoleId
      || expectedRole.digest !== policy.roleDigest
      || expectedRole.write !== policy.write) {
      throw new CompanionError("E_ROLE", "RuntimeRolePolicy does not match the durable worker role.");
    }
  }
  if (profile) {
    const allowed = exactProviderToolList(profile.providerToolIds) || [];
    const denied = exactProviderToolList(profile.deniedProviderToolIds) || [];
    if (profile.id !== policy.providerProfileId
      || profile.contractVersion !== policy.providerProfileVersion
      || profile.agentProfileDigest !== policy.agentProfileDigest
      || allowed.length !== policy.allowedProviderToolIds.length
      || denied.length !== policy.deniedProviderToolIds.length
      || allowed.some((tool, index) => tool !== policy.allowedProviderToolIds[index])
      || denied.some((tool, index) => tool !== policy.deniedProviderToolIds[index])) {
      throw new CompanionError(
        "E_ROLE",
        "RuntimeRolePolicy does not match the durable provider profile or tool ids."
      );
    }
  }
  return policy;
}

export { ROLE_SPECS };
