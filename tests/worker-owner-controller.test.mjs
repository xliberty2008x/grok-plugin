import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  workerOwnerControllerEnvironment,
  workerOwnerControllerSpawnArgs,
  WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID,
  WORKTREE_CLEANUP_REQUEST_ALLOWLIST,
  WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID,
  WORKTREE_INTEGRATION_REQUEST_ALLOWLIST
} from "../plugins/grok/scripts/lib/grok-provider.mjs";
import {
  buildWorkerOwnerSessionLoadRequest,
  normalizeWorkerOwnerSessionLoadResult,
  openWorkerOwnerController,
  WORKTREE_CLOSE_REQUEST_ALLOWLIST,
  WORKTREE_REMOVE_REQUEST_ALLOWLIST
} from "../plugins/grok/scripts/lib/worker-owner-controller.mjs";
import {
  assertWorkerOwnerControllerBinding,
  WORKTREE_CLEANUP_PURPOSE,
  WORKTREE_INTEGRATION_PURPOSE
} from "../plugins/grok/scripts/lib/recursion-guard.mjs";
import { resolveControlWorkspace } from "../plugins/grok/scripts/lib/workspace.mjs";

function git(root, ...args) {
  const run = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
  assert.equal(run.status, 0, run.stderr);
  return String(run.stdout).trim();
}

function privateHomeDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.homedir(), `.${prefix}`));
}

test("owner session load accepts the upstream ACP response shape and rejects a conflicting echoed id", () => {
  const binding = {
    sessionId: "provider-session-1",
    executionRoot: "/private/provider-worktree"
  };
  assert.deepEqual(
    buildWorkerOwnerSessionLoadRequest(binding),
    {
      sessionId: binding.sessionId,
      cwd: binding.executionRoot,
      mcpServers: [],
      _meta: {
        noReplay: true,
        "x.ai/skip_envrc": true,
        "x.ai/restore_code": false,
        codeNavEnabled: false,
        autoMode: false,
        yoloMode: false
      }
    }
  );
  assert.deepEqual(
    normalizeWorkerOwnerSessionLoadResult(
      {
        models: {
          availableModels: [],
          currentModelId: null
        },
        _meta: { replayed: true }
      },
      binding
    ),
    {
      sessionId: binding.sessionId,
      cwd: binding.executionRoot,
      mcpServers: [],
      noReplay: true,
      skipEnvrc: true,
      restoreCode: false,
      codeNavEnabled: false,
      autoMode: false,
      yoloMode: false
    }
  );
  assert.throws(
    () => normalizeWorkerOwnerSessionLoadResult(
      { sessionId: "different-provider-session" },
      binding
    ),
    (error) => error?.code === "E_PROTOCOL"
  );
});

test("owner controller rejects a partial provider executable binding before durable callbacks", async () => {
  const controlRoot = "/private/tmp/grok-owner-binding-control";
  const executionRoot = "/private/tmp/grok-owner-binding-worker";
  let callbackCalls = 0;
  const callbacks = {
    async prepare() { callbackCalls += 1; },
    async activate() { callbackCalls += 1; },
    async settle() { callbackCalls += 1; }
  };
  await assert.rejects(
    openWorkerOwnerController({
      stateDir: "/private/tmp/grok-owner-binding-state",
      root: controlRoot,
      executionRoot,
      binding: {
        purpose: WORKTREE_INTEGRATION_PURPOSE,
        controlWorkspaceId: `cws-${"1".repeat(32)}`,
        controlRoot,
        executionRoot,
        executionBindingDigest: "2".repeat(64),
        effectBindingDigest: "3".repeat(64),
        controllerAttemptId: "4".repeat(32),
        controllerFence: 1,
        holderId: "5".repeat(64),
        targetPath: path.join(controlRoot, "target.txt"),
        operationId: "official-worktree-operation"
      },
      marker: "worker-owner-binding",
      homeMarker: "worker-owner-binding-home",
      profile: null,
      gitCommonDir: "/private/tmp/grok-owner-binding-control/.git",
      baseCommit: "6".repeat(40),
      effect: "apply",
      callbacks,
      providerLaunchBinding: {
        schemaVersion: 1,
        pinRef: `gpin-${"7".repeat(32)}`,
        pinRecordDigest: "8".repeat(64),
        executableIdentityDigest: "9".repeat(64),
        releaseIdentityDigest: "a".repeat(64)
      }
    }),
    (error) => error?.code === "E_PROCESS_IDENTITY"
      && /partial/.test(error.message)
  );
  assert.equal(callbackCalls, 0);
});

test("owner controllers keep integration and cleanup as distinct no-model authorities and remove their homes", () => {
  const root = privateHomeDirectory("grok-owner-control-");
  const stateDir = privateHomeDirectory("grok-owner-state-");
  const previousAuth = process.env.GROK_AUTH_PATH;
  let integrationEnvironment = null;
  let cleanupEnvironment = null;
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "tests@example.com");
    git(root, "config", "user.name", "Grok Plugin Tests");
    fs.writeFileSync(path.join(root, "target.txt"), "before\n", "utf8");
    git(root, "add", "target.txt");
    git(root, "commit", "-m", "initial");
    const baseCommit = git(root, "rev-parse", "HEAD");
    const workerParent = path.join(stateDir, "worktrees", "worker-a");
    fs.mkdirSync(workerParent, { recursive: true, mode: 0o700 });
    const executionRoot = path.join(workerParent, "checkout");
    git(root, "worktree", "add", "--detach", executionRoot, baseCommit);
    fs.chmodSync(workerParent, 0o700);
    const control = resolveControlWorkspace(root);
    const authPath = path.join(stateDir, "source-auth.json");
    fs.writeFileSync(
      authPath,
      `${JSON.stringify({
        test: {
          key: "controller-test-secret-1234567890",
          auth_mode: "oauth",
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
        }
      })}\n`,
      { mode: 0o600 }
    );
    process.env.GROK_AUTH_PATH = authPath;

    const common = {
      controlWorkspaceId: control.controlWorkspaceId,
      controlRoot: control.controlRoot,
      executionRoot,
      executionBindingDigest: "a".repeat(64),
      effectBindingDigest: "b".repeat(64),
      controllerAttemptId: "c".repeat(32),
      controllerFence: 1,
      holderId: "d".repeat(64),
      providerSpawnIntentId: "e".repeat(32)
    };
    const integrationBinding = {
      purpose: WORKTREE_INTEGRATION_PURPOSE,
      ...common,
      targetPath: path.join(root, "target.txt"),
      operationId: "official-worktree-operation"
    };
    const cleanupBinding = {
      purpose: WORKTREE_CLEANUP_PURPOSE,
      ...common,
      managedWorktreeParent: workerParent,
      sessionId: "provider-session-1",
      providerHomeId: "worker-provider-home-1"
    };
    assert.equal(
      assertWorkerOwnerControllerBinding(integrationBinding),
      integrationBinding
    );
    assert.equal(
      assertWorkerOwnerControllerBinding(cleanupBinding),
      cleanupBinding
    );
    assert.throws(
      () => assertWorkerOwnerControllerBinding({
        ...integrationBinding,
        unexpected: true
      }),
      (error) => error?.code === "E_PROCESS_IDENTITY"
    );

    integrationEnvironment = workerOwnerControllerEnvironment(
      stateDir,
      root,
      executionRoot,
      {
        purpose: WORKTREE_INTEGRATION_PURPOSE,
        homeMarker: "integration-controller-a",
        gitCommonDir: control.gitCommonDir,
        baseCommit,
        targetPath: path.join(root, "target.txt")
      }
    );
    cleanupEnvironment = workerOwnerControllerEnvironment(
      stateDir,
      root,
      executionRoot,
      {
        purpose: WORKTREE_CLEANUP_PURPOSE,
        homeMarker: "cleanup-controller-a",
        gitCommonDir: control.gitCommonDir,
        baseCommit,
        managedWorktreeParent: workerParent
      }
    );
    assert.equal(
      integrationEnvironment.profileId,
      WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID
    );
    assert.equal(
      cleanupEnvironment.profileId,
      WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID
    );
    assert.notEqual(
      integrationEnvironment.sandboxProfile,
      cleanupEnvironment.sandboxProfile
    );
    const integrationSandbox = fs.readFileSync(
      path.join(integrationEnvironment.grokHome, "sandbox.toml"),
      "utf8"
    );
    const cleanupSandbox = fs.readFileSync(
      path.join(cleanupEnvironment.grokHome, "sandbox.toml"),
      "utf8"
    );
    assert.match(
      integrationSandbox,
      new RegExp(`read_write = \\[${JSON.stringify(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`)
    );
    assert.equal(
      integrationSandbox.includes(
        `read_write = [${JSON.stringify(path.join(root, "target.txt"))}]`
      ),
      false
    );
    assert.match(
      cleanupSandbox,
      new RegExp(JSON.stringify(workerParent).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.equal(
      cleanupSandbox.includes(
        `read_write = [${JSON.stringify(path.join(root, "target.txt"))}]`
      ),
      false
    );

    for (const list of [
      WORKTREE_INTEGRATION_REQUEST_ALLOWLIST,
      WORKTREE_CLEANUP_REQUEST_ALLOWLIST,
      WORKTREE_CLOSE_REQUEST_ALLOWLIST,
      WORKTREE_REMOVE_REQUEST_ALLOWLIST
    ]) {
      assert.equal(list.includes("_x.ai/git/worktree/create"), false);
      assert.equal(list.includes("session/prompt"), false);
      assert.equal(list.includes("session/new"), false);
    }
    assert.deepEqual(WORKTREE_INTEGRATION_REQUEST_ALLOWLIST, [
      "initialize",
      "_x.ai/git/worktree/apply"
    ]);
    assert.deepEqual(WORKTREE_CLOSE_REQUEST_ALLOWLIST, [
      "initialize",
      "authenticate",
      "session/load",
      "_x.ai/session/close"
    ]);
    assert.deepEqual(WORKTREE_REMOVE_REQUEST_ALLOWLIST, [
      "initialize",
      "_x.ai/git/worktree/remove"
    ]);

    for (const environment of [
      integrationEnvironment,
      cleanupEnvironment
    ]) {
      const args = workerOwnerControllerSpawnArgs({
        environment,
        leaderSocket: path.join(environment.controllerCwd, "leader.sock")
      });
      assert.equal(args.includes("--model"), false);
      assert.equal(args.includes("--reasoning-effort"), false);
      assert.equal(args.includes("session/prompt"), false);
      assert.equal(args.includes("_x.ai/git/worktree/create"), false);
      for (const denied of ["Bash", "Edit", "Write", "Read", "Grep", "WebSearch"]) {
        const index = args.findIndex((entry, position) => (
          entry === "--deny" && args[position + 1] === denied
        ));
        assert.notEqual(index, -1);
      }
      environment.stageCredential();
      environment.revokeCredential();
      environment.assertCredentialAbsent();
      const home = environment.home;
      environment.cleanup(null);
      environment.assertHomeAbsent();
      assert.equal(fs.existsSync(home), false);
    }
    integrationEnvironment = null;
    cleanupEnvironment = null;
  } finally {
    if (previousAuth === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousAuth;
    try { integrationEnvironment?.revokeCredential(); } catch {}
    try { cleanupEnvironment?.revokeCredential(); } catch {}
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
