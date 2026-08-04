import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as provider from "../plugins/grok/scripts/lib/grok-provider.mjs";
import * as bootstrapClient from "../plugins/grok/scripts/lib/provider-bootstrap-client.mjs";
import * as controllerEnvironments from "../plugins/grok/scripts/lib/provider-controller-environments.mjs";
import * as core from "../plugins/grok/scripts/lib/provider-core.mjs";
import * as credentials from "../plugins/grok/scripts/lib/provider-credentials.mjs";
import * as gitController from "../plugins/grok/scripts/lib/provider-git-controller.mjs";
import * as processRuntime from "../plugins/grok/scripts/lib/provider-process.mjs";
import * as profile from "../plugins/grok/scripts/lib/provider-profile.mjs";
import * as reviewContract from "../plugins/grok/scripts/lib/provider-review-contract.mjs";
import * as taskEnvironment from "../plugins/grok/scripts/lib/provider-task-environment.mjs";
import * as worktreeContract from "../plugins/grok/scripts/lib/provider-worktree-contract.mjs";

const LIB = fileURLToPath(new URL("../plugins/grok/scripts/lib/", import.meta.url));

const PROVIDER_EXPORTS = Object.freeze([
  "DEFAULT_REVIEW_REPAIR_PROMPT",
  "MAX_APP_REVIEW_OUTPUT_BYTES",
  "MAX_SUGGESTION_REPLACEMENT_BYTES",
  "REVIEW_SCHEMA",
  "WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID",
  "WORKTREE_CLEANUP_REQUEST_ALLOWLIST",
  "WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID",
  "WORKTREE_INTEGRATION_REQUEST_ALLOWLIST",
  "assertControllerGitCheckoutSafe",
  "assertProviderBootstrapPromotionMessage",
  "assertProviderBootstrapReadyMessage",
  "assertProviderPlatform",
  "assertTransferEffort",
  "authenticateBoundBootstrapGuard",
  "captureSpawnIdentity",
  "childEnvironment",
  "cleanupBoundBootstrapStart",
  "cleanupReviewEnvironment",
  "cleanupTaskRuntimeArtifacts",
  "createProviderBootstrapLaunch",
  "deleteSession",
  "discoverGrok",
  "ensureChildExit",
  "formatResumeCommand",
  "gatedCleanupReviewEnvironment",
  "grokVersion",
  "inspectImportedSessionPresence",
  "inspectIsolation",
  "isImportedSessionReady",
  "listAdvertisedModels",
  "openProvider",
  "parseAdvertisedModels",
  "probe",
  "processStartToken",
  "promoteProviderBootstrap",
  "providerCleanupIdentity",
  "publishProviderBootstrapSpec",
  "recordBoundBootstrapNoChild",
  "resolveTrustedOutputSchema",
  "reviewEnvironment",
  "revokeTaskCredential",
  "runHeadless",
  "runProvider",
  "runStructuredReview",
  "selectAcpPermissionOption",
  "selectTransferModel",
  "settleWorktreeBootstrapRegistrationFailure",
  "taskCredentialEnvironment",
  "taskEnvironment",
  "validateAppReview",
  "validateReview",
  "waitForImportedSession",
  "waitForProviderBootstrapReady",
  "workerOwnerControllerEnvironment",
  "workerOwnerControllerSpawnArgs",
  "workerSessionCloseControllerEnvironment"
]);

const PROVIDER_AB_OWNERS = Object.freeze(Object.fromEntries([
  [core, [
    "assertProviderPlatform",
    "childEnvironment",
    "discoverGrok",
    "grokVersion"
  ]],
  [worktreeContract, [
    "WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID",
    "WORKTREE_CLEANUP_REQUEST_ALLOWLIST",
    "WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID",
    "WORKTREE_INTEGRATION_REQUEST_ALLOWLIST"
  ]],
  [reviewContract, [
    "DEFAULT_REVIEW_REPAIR_PROMPT",
    "MAX_APP_REVIEW_OUTPUT_BYTES",
    "MAX_SUGGESTION_REPLACEMENT_BYTES",
    "REVIEW_SCHEMA",
    "resolveTrustedOutputSchema",
    "selectAcpPermissionOption",
    "validateAppReview",
    "validateReview"
  ]],
  [credentials, [
    "cleanupReviewEnvironment",
    "gatedCleanupReviewEnvironment",
    "reviewEnvironment"
  ]],
  [gitController, ["assertControllerGitCheckoutSafe"]],
  [taskEnvironment, ["taskEnvironment"]],
  [controllerEnvironments, [
    "cleanupTaskRuntimeArtifacts",
    "revokeTaskCredential",
    "taskCredentialEnvironment",
    "workerOwnerControllerEnvironment",
    "workerSessionCloseControllerEnvironment"
  ]],
  [profile, [
    "inspectIsolation",
    "workerOwnerControllerSpawnArgs"
  ]],
  [processRuntime, [
    "captureSpawnIdentity",
    "ensureChildExit",
    "providerCleanupIdentity"
  ]],
  [bootstrapClient, [
    "assertProviderBootstrapPromotionMessage",
    "assertProviderBootstrapReadyMessage",
    "authenticateBoundBootstrapGuard",
    "cleanupBoundBootstrapStart",
    "createProviderBootstrapLaunch",
    "promoteProviderBootstrap",
    "publishProviderBootstrapSpec",
    "recordBoundBootstrapNoChild",
    "settleWorktreeBootstrapRegistrationFailure",
    "waitForProviderBootstrapReady"
  ]]
].flatMap(([module, names]) => names.map((name) => [name, module[name]]))));

const PROVIDER_AB_FILES = Object.freeze([
  "provider-core.mjs",
  "provider-credentials.mjs",
  "provider-git-controller.mjs",
  "provider-bootstrap-client.mjs",
  "provider-controller-environments.mjs",
  "provider-process.mjs",
  "provider-profile.mjs",
  "provider-review-contract.mjs",
  "provider-task-environment.mjs",
  "provider-worktree-contract.mjs"
]);

function importEdges(file, knownFiles) {
  const source = fs.readFileSync(path.join(LIB, file), "utf8");
  return [...source.matchAll(/\bfrom\s+"\.\/([^"]+\.mjs)"/gu)]
    .map((match) => match[1])
    .filter((dependency) => knownFiles.has(dependency));
}

function stronglyConnectedComponents(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const components = [];

  function visit(node) {
    indices.set(node, index);
    lowlinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const dependency of graph.get(node) || []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowlinks.set(node, Math.min(lowlinks.get(node), lowlinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowlinks.set(node, Math.min(lowlinks.get(node), indices.get(dependency)));
      }
    }
    if (lowlinks.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    components.push(component.sort());
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

test("grok-provider preserves its exact public surface while Provider A and B move ownership", () => {
  assert.deepEqual(Object.keys(provider).sort(), PROVIDER_EXPORTS);
  assert.equal(Object.hasOwn(provider, "default"), false);
  assert.equal(Object.keys(PROVIDER_AB_OWNERS).length, 41);
  for (const [name, owner] of Object.entries(PROVIDER_AB_OWNERS)) {
    assert.equal(provider[name], owner, `${name} lost referential parity`);
  }
});

test("Provider A and B domains stay bounded, acyclic, and independent of the compatibility surface", () => {
  for (const file of PROVIDER_AB_FILES) {
    const source = fs.readFileSync(path.join(LIB, file), "utf8");
    assert.ok(source.split("\n").length <= 1500, `${file} exceeded 1500 lines`);
    assert.doesNotMatch(
      source,
      /\bfrom\s+"\.\/grok-provider\.mjs"/u,
      `${file} imports the compatibility surface`
    );
  }

  const files = [
    "grok-provider.mjs",
    "provider-capability.mjs",
    ...PROVIDER_AB_FILES
  ];
  const knownFiles = new Set(files);
  const graph = new Map(files.map((file) => [file, importEdges(file, knownFiles)]));
  const cycles = stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1
      || (graph.get(component[0]) || []).includes(component[0]));
  assert.deepEqual(cycles, []);
});

test("Provider B consumers import their owning domains instead of the compatibility surface", () => {
  const cleanupConsumers = [
    "worker-mutation.mjs",
    "worker-recovery.mjs",
    "worker-runtime.mjs"
  ];
  for (const file of cleanupConsumers) {
    const source = fs.readFileSync(path.join(LIB, file), "utf8");
    assert.match(source, /\bfrom\s+"\.\/provider-controller-environments\.mjs"/u);
    assert.doesNotMatch(source, /\bfrom\s+"\.\/grok-provider\.mjs"/u);
  }

  const ownerController = fs.readFileSync(
    path.join(LIB, "worker-owner-controller.mjs"),
    "utf8"
  );
  for (const domain of [
    "provider-bootstrap-client.mjs",
    "provider-controller-environments.mjs",
    "provider-process.mjs",
    "provider-profile.mjs"
  ]) {
    assert.match(ownerController, new RegExp(
      `\\bfrom\\s+"\\./${domain.replaceAll(".", "\\.")}"`,
      "u"
    ));
  }
  assert.doesNotMatch(ownerController, /\bfrom\s+"\.\/grok-provider\.mjs"/u);
});
