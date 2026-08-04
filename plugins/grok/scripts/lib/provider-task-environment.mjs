import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { hostCommand } from "./host.mjs";
import {
  childEnvironment,
  safeMarker
} from "./provider-core.mjs";
import {
  atomicPrivateFile,
  directoryIdentityMatches,
  ensureFreshCachedCredential,
  existingPrivateDirectoryIdentity,
  freshCachedCredentialPayload,
  privateDirectory,
  stageRevocableTaskCredential,
  writeReviewCredential
} from "./provider-credentials.mjs";
import {
  assertControllerAuthorityOutsideBroadTemp,
  assertControllerGitCheckoutSafe,
  assertControllerGitSeparation,
  assertNoGitObjectAlternates,
  canonicalGitCommonDirectory,
  canonicalProvisioningDestination,
  captureGitInfoAttributesBinding,
  controllerGitEnvironment,
  ensureGitWorktreesMetadataRoot,
  protectedGitPaths,
  recaptureTrustedGitInstallation,
  sameGitInfoAttributesBinding,
  sameTrustedGitInstallation,
  trustedGitInstallation
} from "./provider-git-controller.mjs";
import {
  MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS,
  WORKTREE_CONTROLLER_PROFILE_ID
} from "./provider-worktree-contract.mjs";

function prepareTaskEnvironmentAuthority({
  root,
  home,
  grokHome,
  lineage,
  profile,
  stateDir,
  worktreeProvisioningController,
  worktreeProvisioningDestinationParent,
  worktreeProvisioningExpectedRoot,
  worktreeProvisioningGitCommonDir,
  worktreeProvisioningBaseCommit
}) {
  const controllerCwd = worktreeProvisioningController
    ? path.join(home, "controller-cwd")
    : null;
  if (controllerCwd) privateDirectory(controllerCwd);
  const controlRoot = fs.realpathSync(root);
  atomicPrivateFile(path.join(grokHome, "config.toml"), `[skills]\nignore = [${JSON.stringify(controlRoot)}]\n\n[subagents]\nenabled = false\n\n[features]\nlsp_tools = false\n`);
  const gitPaths = worktreeProvisioningController ? [] : protectedGitPaths(root);
  const trustedPath = process.env.PATH;
  const gitInstallation = worktreeProvisioningController
    ? trustedGitInstallation(root, trustedPath)
    : null;
  const gitInstallationRoot = gitInstallation?.installationRoot || null;
  const provisioningDestination = worktreeProvisioningController
    ? canonicalProvisioningDestination({
        parent: worktreeProvisioningDestinationParent,
        expectedRoot: worktreeProvisioningExpectedRoot,
        stateDir
      })
    : null;
  const discoveredGitCommonDir = gitInstallation
    ? canonicalGitCommonDirectory(gitInstallation, controlRoot)
    : null;
  const gitCommonDir = gitInstallation
    ? (() => {
        if (typeof worktreeProvisioningGitCommonDir !== "string"
          || !path.isAbsolute(worktreeProvisioningGitCommonDir)
          || path.normalize(worktreeProvisioningGitCommonDir)
            !== worktreeProvisioningGitCommonDir
          || fs.realpathSync(worktreeProvisioningGitCommonDir)
            !== discoveredGitCommonDir) {
          throw new CompanionError(
            "E_CAPABILITY",
            "The caller-supplied Git common directory does not match the exact source repository."
          );
        }
        return discoveredGitCommonDir;
      })()
    : null;
  if (worktreeProvisioningController
    && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
      worktreeProvisioningBaseCommit || ""
    )) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Official provisioning requires one exact base commit."
    );
  }
  if (gitInstallation) {
    assertControllerAuthorityOutsideBroadTemp({
      controlRoot,
      gitCommonDir,
      stateDir,
      destinationParent: provisioningDestination.parent
    });
    assertControllerGitSeparation({
      gitInstallation,
      controlRoot,
      stateDir,
      home,
      destinationRoot: provisioningDestination.parent
    });
  }
  if (gitCommonDir) assertNoGitObjectAlternates(gitCommonDir);
  const gitWorktreesMetadataRoot = gitCommonDir
    ? ensureGitWorktreesMetadataRoot(gitCommonDir)
    : null;
  const gitInfoAttributesBinding = gitCommonDir
    ? captureGitInfoAttributesBinding(gitCommonDir)
    : null;
  const sandboxProfile = `companion_${crypto.createHash("sha256").update(
    `${lineage}:${profile.id}:${worktreeProvisioningController ? "worktree-provisioning" : "task"}`
  ).digest("hex").slice(0, 20)}`;
  const readOnly = [
    ...(gitInstallationRoot ? [controlRoot, gitCommonDir, gitInstallationRoot] : [])
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  const readWrite = [
    provisioningDestination?.parent,
    gitWorktreesMetadataRoot
  ].filter(Boolean);
  atomicPrivateFile(
    path.join(grokHome, "sandbox.toml"),
    [
      `[profiles.${sandboxProfile}]`,
      'extends = "strict"',
      "restrict_network = true",
      ...(readOnly.length
        ? [`read_only = [${readOnly.map((item) => JSON.stringify(item)).join(", ")}]`]
        : []),
      ...(readWrite.length
        ? [`read_write = [${readWrite.map((item) => JSON.stringify(item)).join(", ")}]`]
        : []),
      `deny = [${gitPaths.map((item) => JSON.stringify(item)).join(", ")}]`,
      ""
    ].join("\n")
  );
  return {
    controllerCwd,
    controlRoot,
    gitInstallation,
    gitInstallationRoot,
    provisioningDestination,
    gitCommonDir,
    gitWorktreesMetadataRoot,
    gitInfoAttributesBinding,
    sandboxProfile
  };
}

export function taskEnvironment(stateDir, root, profile, homeMarker = "task", {
    providerExecutableBinary = null,
    worktreeProvisioningController = false,
    worktreeProvisioningDestinationParent = null,
    worktreeProvisioningExpectedRoot = null,
    worktreeProvisioningGitCommonDir = null,
    worktreeProvisioningBaseCommit = null
} = {}) {
  if (!profile?.id || !/^rescue-(read|write|report)-v3$/.test(profile.id)) throw new CompanionError("E_STATE", "A qualified isolated task profile is required.");
  const lineage = safeMarker(homeMarker);
  const home = path.join(stateDir, "task-homes", lineage), grokHome = path.join(home, ".grok");
  let stagedCredential = null;
  let stagedCredentialRevoked = false;
  let controllerHomeCreated = false;
  try {
    if (worktreeProvisioningController) {
      privateDirectory(path.dirname(home));
      try {
        fs.mkdirSync(home, { mode: 0o700 });
        controllerHomeCreated = true;
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new CompanionError(
            "E_STATE",
            "A worktree controller claim home already exists; refusing ambiguous ownership."
          );
        } else {
          throw error;
        }
      }
      privateDirectory(home);
    } else {
      privateDirectory(home);
    }
    privateDirectory(grokHome);
    const {
      controllerCwd,
      controlRoot,
      gitInstallation,
      gitInstallationRoot,
      provisioningDestination,
      gitCommonDir,
      gitWorktreesMetadataRoot,
      gitInfoAttributesBinding,
      sandboxProfile
    } = prepareTaskEnvironmentAuthority({
      root,
      home,
      grokHome,
      lineage,
      profile,
      stateDir,
      worktreeProvisioningController,
      worktreeProvisioningDestinationParent,
      worktreeProvisioningExpectedRoot,
      worktreeProvisioningGitCommonDir,
      worktreeProvisioningBaseCommit
    });
    const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
    if (!fs.existsSync(authPath)) throw new CompanionError("E_AUTH_REQUIRED", `Grok cached authentication is unavailable. Run \`grok login\`, then ${hostCommand("setup")}.`);
    if (!worktreeProvisioningController) {
      ensureFreshCachedCredential(
        authPath,
        45 * 60 * 1000,
        providerExecutableBinary
      );
    }
    const authFile = path.join(grokHome, "auth.json");
    const directoryIdentities = worktreeProvisioningController
      ? [home, grokHome].map(existingPrivateDirectoryIdentity)
      : null;
    const knownSecrets = [];
    if (!worktreeProvisioningController) {
      knownSecrets.push(
        writeReviewCredential(authPath, authFile, { refresh: true })
      );
    }
    const gitEnv = gitInstallation
      ? controllerGitEnvironment(gitInstallation)
      : {};
    if (gitInstallation) {
      assertControllerGitCheckoutSafe({
        gitExecutable: gitInstallation.executable,
        gitExecutableDirectory: gitInstallation.executableDirectory,
        gitInstallationRoot,
        workspaceRoot: controlRoot,
        baseCommit: worktreeProvisioningBaseCommit
      });
    }
    const env = childEnvironment({
      ...gitEnv,
      HOME: home,
      USERPROFILE: home,
      GROK_HOME: grokHome,
      GROK_FOLDER_TRUST: "1",
      GROK_SUBAGENTS: "0",
      GROK_MEMORY: "0",
      GROK_WEB_FETCH: "0",
      GROK_LSP_TOOLS: "0",
      ...(gitInstallation
        ? { PATH: gitInstallation.executableDirectory }
        : {})
    });
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
    return {
      env,
      home,
      grokHome,
      knownSecrets,
      sandboxProfile,
      ...(controllerCwd ? {
        controllerCwd,
        controllerProfileId: WORKTREE_CONTROLLER_PROFILE_ID
      } : {}),
      ...(gitInstallationRoot ? { gitInstallationRoot } : {}),
      ...(gitCommonDir ? { gitCommonDir, gitWorktreesMetadataRoot } : {}),
      ...(worktreeProvisioningController ? {
        worktreeProvisioningBaseCommit,
        gitInfoAttributesState: gitInfoAttributesBinding.state,
        ...(gitInfoAttributesBinding.state === "present"
          ? { gitInfoAttributesDigest: gitInfoAttributesBinding.digest }
          : {})
      } : {}),
      ...(gitInstallation ? {
        gitExecutable: gitInstallation.executable,
        gitExecutableDirectory: gitInstallation.executableDirectory,
        gitExecutableDigest: gitInstallation.executableDigest,
        verifyGitExecutable() {
          const current = recaptureTrustedGitInstallation(gitInstallation);
          if (!sameTrustedGitInstallation(gitInstallation, current)) {
            throw new CompanionError(
              "E_CAPABILITY",
              "The trusted Git executable or its parent changed before official provisioning."
            );
          }
          const currentInfoAttributes = captureGitInfoAttributesBinding(
            gitCommonDir
          );
          assertNoGitObjectAlternates(gitCommonDir);
          if (!sameGitInfoAttributesBinding(
            gitInfoAttributesBinding,
            currentInfoAttributes
          )) {
            throw new CompanionError(
              "E_CAPABILITY",
              "Git info attributes changed before official provisioning."
            );
          }
          assertControllerGitCheckoutSafe({
            gitExecutable: current.executable,
            gitExecutableDirectory: current.executableDirectory,
            gitInstallationRoot: current.installationRoot,
            workspaceRoot: controlRoot,
            baseCommit: worktreeProvisioningBaseCommit
          });
          return current;
        }
      } : {}),
      ...(provisioningDestination ? {
        provisioningDestinationParent: provisioningDestination.parent,
        provisioningExpectedRoot: provisioningDestination.expectedRoot
      } : {}),
      stageCredential() {
        if (!worktreeProvisioningController) return;
        if (stagedCredentialRevoked) {
          throw new CompanionError(
            "E_STATE",
            "A revoked worktree controller credential cannot be restaged."
          );
        }
        if (stagedCredential) return;
        // The credential is needed only through authenticated session creation
        // and is revoked before the first workspace-capable prompt. Requiring a
        // full job horizon here rejects an otherwise accepted cached session
        // during its final rotation window even though no reusable credential
        // survives into task execution.
        const payload = freshCachedCredentialPayload(
          authPath,
          MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS
        );
        stagedCredential = stageRevocableTaskCredential(
          authPath,
          authFile,
          directoryIdentities,
          payload
        );
        knownSecrets.push(stagedCredential.key);
      },
      revokeCredential() {
        if (stagedCredential) {
          if (stagedCredentialRevoked) return;
          try {
            // Grok may atomically refresh auth.json during initialize. Rebind
            // the revocation handle to that exact private replacement before
            // neutralizing and unlinking it.
            stagedCredential.refresh();
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          stagedCredential.revoke();
          stagedCredentialRevoked = true;
          return;
        }
        try { fs.unlinkSync(authFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
      },
      assertCredentialAbsent() {
        if (!worktreeProvisioningController) return;
        if (!directoryIdentities.every(directoryIdentityMatches)) {
          throw new CompanionError(
            "E_STATE",
            "The controller credential parent changed before absence proof."
          );
        }
        try {
          fs.lstatSync(authFile);
          throw new CompanionError(
            "E_STATE",
            "The controller credential remained after initialization."
          );
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    };
  } catch (error) {
    if (worktreeProvisioningController) {
      let cleanupFailure = null;
      try { stagedCredential?.revoke(); }
      catch (failure) { cleanupFailure = failure; }
      try {
        if (controllerHomeCreated) {
          fs.rmSync(home, { recursive: true, force: true });
        }
      }
      catch (failure) { cleanupFailure ||= failure; }
      if (cleanupFailure) {
        throw new CompanionError(
          "E_STATE",
          "The failed controller environment could not be removed transactionally."
        );
      }
    }
    throw error;
  }
}
