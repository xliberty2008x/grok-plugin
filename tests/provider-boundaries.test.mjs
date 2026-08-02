import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as provider from "../plugins/grok/scripts/lib/grok-provider.mjs";
import * as acpRuntime from "../plugins/grok/scripts/lib/provider-acp-runtime.mjs";
import * as bootstrapClient from "../plugins/grok/scripts/lib/provider-bootstrap-client.mjs";
import * as controllerEnvironments from "../plugins/grok/scripts/lib/provider-controller-environments.mjs";
import * as core from "../plugins/grok/scripts/lib/provider-core.mjs";
import * as credentials from "../plugins/grok/scripts/lib/provider-credentials.mjs";
import * as gitController from "../plugins/grok/scripts/lib/provider-git-controller.mjs";
import * as headlessRuntime from "../plugins/grok/scripts/lib/provider-headless-runtime.mjs";
import * as processRuntime from "../plugins/grok/scripts/lib/provider-process.mjs";
import * as profile from "../plugins/grok/scripts/lib/provider-profile.mjs";
import * as reviewContract from "../plugins/grok/scripts/lib/provider-review-contract.mjs";
import * as sessions from "../plugins/grok/scripts/lib/provider-sessions.mjs";
import * as taskEnvironment from "../plugins/grok/scripts/lib/provider-task-environment.mjs";
import * as worktreeContract from "../plugins/grok/scripts/lib/provider-worktree-contract.mjs";
import { processStartToken } from "../plugins/grok/scripts/lib/process-control.mjs";

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

const OWNER = Object.freeze({
  processStartToken,
  ...Object.fromEntries([
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
    ]],
    [acpRuntime, ["openProvider"]],
    [headlessRuntime, [
      "runHeadless",
      "runProvider",
      "runStructuredReview"
    ]],
    [sessions, [
      "assertTransferEffort",
      "deleteSession",
      "formatResumeCommand",
      "inspectImportedSessionPresence",
      "isImportedSessionReady",
      "listAdvertisedModels",
      "parseAdvertisedModels",
      "probe",
      "selectTransferModel",
      "waitForImportedSession"
    ]]
  ].flatMap(([module, names]) => names.map((name) => [name, module[name]])))
});

const DOMAIN_FILES = Object.freeze(
  fs.readdirSync(LIB)
    .filter((file) => /^provider-.*\.mjs$/u.test(file))
    .sort()
);

function importEdges(file) {
  const source = fs.readFileSync(path.join(LIB, file), "utf8");
  return [...source.matchAll(/\bfrom\s+"\.\/([^"]+\.mjs)"/gu)]
    .map((match) => match[1])
    .filter((dependency) => dependency === "grok-provider.mjs"
      || DOMAIN_FILES.includes(dependency));
}

function stronglyConnectedComponents(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const components = [];

  const visit = (node) => {
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
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

test("grok-provider remains an exact explicit compatibility facade", () => {
  assert.deepEqual(Object.keys(provider).sort(), PROVIDER_EXPORTS);
  assert.equal(Object.hasOwn(provider, "default"), false);
  assert.deepEqual(Object.keys(OWNER).sort(), PROVIDER_EXPORTS);
  for (const name of PROVIDER_EXPORTS) {
    assert.equal(provider[name], OWNER[name], `${name} lost referential parity`);
  }
});

test("provider domains stay bounded, acyclic, and independent of the facade", () => {
  const facade = fs.readFileSync(path.join(LIB, "grok-provider.mjs"), "utf8");
  assert.ok(facade.split("\n").length <= 300);
  assert.doesNotMatch(facade, /\b(?:async\s+)?function\s+[A-Za-z_$]/u);
  assert.doesNotMatch(facade, /\bclass\s+[A-Za-z_$]/u);

  for (const file of DOMAIN_FILES) {
    const source = fs.readFileSync(path.join(LIB, file), "utf8");
    assert.ok(source.split("\n").length <= 1500, `${file} exceeded 1500 lines`);
    assert.doesNotMatch(
      source,
      /\bfrom\s+"\.\/grok-provider\.mjs"/u,
      `${file} imports the compatibility facade`
    );
  }

  const files = ["grok-provider.mjs", ...DOMAIN_FILES];
  const graph = new Map(files.map((file) => [file, importEdges(file)]));
  const cycles = stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1
      || (graph.get(component[0]) || []).includes(component[0]));
  assert.deepEqual(cycles, []);
});
