// Stable compatibility surface for Grok provider consumers.
//
// Provider behavior lives in cohesive, acyclic domain modules. Keep this file
// as explicit named re-exports so new dependencies cannot grow another
// monolithic provider implementation or hide facade cycles.

export { processStartToken } from "./process-control.mjs";

export {
  assertProviderPlatform,
  childEnvironment,
  discoverGrok,
  grokVersion
} from "./provider-core.mjs";

export {
  WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID,
  WORKTREE_CLEANUP_REQUEST_ALLOWLIST,
  WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID,
  WORKTREE_INTEGRATION_REQUEST_ALLOWLIST
} from "./provider-worktree-contract.mjs";

export {
  DEFAULT_REVIEW_REPAIR_PROMPT,
  MAX_APP_REVIEW_OUTPUT_BYTES,
  MAX_SUGGESTION_REPLACEMENT_BYTES,
  REVIEW_SCHEMA,
  resolveTrustedOutputSchema,
  selectAcpPermissionOption,
  validateAppReview,
  validateReview
} from "./provider-review-contract.mjs";

export {
  cleanupReviewEnvironment,
  gatedCleanupReviewEnvironment,
  reviewEnvironment
} from "./provider-credentials.mjs";

export {
  assertControllerGitCheckoutSafe
} from "./provider-git-controller.mjs";

export { taskEnvironment } from "./provider-task-environment.mjs";

export {
  cleanupTaskRuntimeArtifacts,
  revokeTaskCredential,
  taskCredentialEnvironment,
  workerOwnerControllerEnvironment,
  workerSessionCloseControllerEnvironment
} from "./provider-controller-environments.mjs";

export {
  inspectIsolation,
  workerOwnerControllerSpawnArgs
} from "./provider-profile.mjs";

export {
  captureSpawnIdentity,
  ensureChildExit,
  providerCleanupIdentity
} from "./provider-process.mjs";

export {
  assertProviderBootstrapPromotionMessage,
  assertProviderBootstrapReadyMessage,
  authenticateBoundBootstrapGuard,
  cleanupBoundBootstrapStart,
  createProviderBootstrapLaunch,
  promoteProviderBootstrap,
  publishProviderBootstrapSpec,
  recordBoundBootstrapNoChild,
  settleWorktreeBootstrapRegistrationFailure,
  waitForProviderBootstrapReady
} from "./provider-bootstrap-client.mjs";

export { openProvider } from "./provider-acp-runtime.mjs";

export {
  runHeadless,
  runProvider,
  runStructuredReview
} from "./provider-headless-runtime.mjs";

export {
  assertTransferEffort,
  deleteSession,
  formatResumeCommand,
  inspectImportedSessionPresence,
  isImportedSessionReady,
  listAdvertisedModels,
  parseAdvertisedModels,
  probe,
  selectTransferModel,
  waitForImportedSession
} from "./provider-sessions.mjs";
