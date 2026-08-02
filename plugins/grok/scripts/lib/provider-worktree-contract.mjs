import path from "node:path";

import { CompanionError } from "./errors.mjs";
import {
  WORKTREE_CLEANUP_PURPOSE,
  WORKTREE_INTEGRATION_PURPOSE
} from "./recursion-guard.mjs";

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const EXACT_NONCE_ID = /^[0-9a-f]{32}$/;
export const OPAQUE_ID = /^[0-9a-f]{32,64}$/;
export const WORKTREE_PROVISIONING_PURPOSE = "worktree-provisioning";
export const WORKTREE_CONTROLLER_PROFILE_ID = "worktree-controller-v1";
export const WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID =
  "worktree-integration-controller-v1";
export const WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID =
  "worktree-cleanup-controller-v1";
export const MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS = 2 * 60 * 1000;
export const WORKTREE_CONTROLLER_REQUEST_ALLOWLIST = Object.freeze([
  "initialize",
  "_x.ai/git/worktree/create",
  "_x.ai/session/close"
]);
export const WORKTREE_INTEGRATION_REQUEST_ALLOWLIST = Object.freeze([
  "initialize",
  "_x.ai/git/worktree/apply"
]);
export const WORKTREE_CLEANUP_REQUEST_ALLOWLIST = Object.freeze([
  "initialize",
  "authenticate",
  "session/load",
  "_x.ai/session/close",
  "_x.ai/git/worktree/remove"
]);
export const WORKTREE_PROVISIONING_BINDING_KEYS = new Set([
  "purpose",
  "controlWorkspaceId",
  "controlRoot",
  "expectedExecutionRoot",
  "executionBindingDigest",
  "provisioningAttemptId",
  "provisioningFence",
  "holderId",
  "providerSpawnIntentId"
]);

export function exactRecord(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}
export function isWorktreeProvisioningBinding(binding) {
  return binding?.purpose === WORKTREE_PROVISIONING_PURPOSE;
}

export function isWorkerOwnerControllerBinding(binding) {
  return binding?.purpose === WORKTREE_INTEGRATION_PURPOSE
    || binding?.purpose === WORKTREE_CLEANUP_PURPOSE;
}

export function workerOwnerControllerProfileId(purpose) {
  if (purpose === WORKTREE_INTEGRATION_PURPOSE) {
    return WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID;
  }
  if (purpose === WORKTREE_CLEANUP_PURPOSE) {
    return WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID;
  }
  throw new CompanionError(
    "E_SECURITY_PROFILE",
    "Unknown worker owner-controller purpose."
  );
}

export function validWorktreeProvisioningBinding(binding, root = null) {
  return exactRecord(binding, WORKTREE_PROVISIONING_BINDING_KEYS)
    && binding.purpose === WORKTREE_PROVISIONING_PURPOSE
    && /^cws-[0-9a-f]{32}$/.test(binding.controlWorkspaceId || "")
    && typeof binding.controlRoot === "string"
    && path.isAbsolute(binding.controlRoot)
    && path.normalize(binding.controlRoot) === binding.controlRoot
    && (root === null || (
      typeof root === "string"
      && path.isAbsolute(root)
      && path.normalize(root) === root
      && root !== binding.controlRoot
      && root !== binding.expectedExecutionRoot
    ))
    && typeof binding.expectedExecutionRoot === "string"
    && path.isAbsolute(binding.expectedExecutionRoot)
    && path.normalize(binding.expectedExecutionRoot) === binding.expectedExecutionRoot
    && binding.expectedExecutionRoot !== binding.controlRoot
    && SHA256_HEX.test(binding.executionBindingDigest || "")
    && EXACT_NONCE_ID.test(binding.provisioningAttemptId || "")
    && Number.isSafeInteger(binding.provisioningFence)
    && binding.provisioningFence > 0
    && OPAQUE_ID.test(binding.holderId || "")
    && EXACT_NONCE_ID.test(binding.providerSpawnIntentId || "");
}
