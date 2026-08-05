import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { CompanionError } from "./errors.mjs";
import { hostCommand } from "./host.mjs";
import {
  assertCompleteDetachedOwnedIdentity,
  processGroupGone
} from "./process-control.mjs";
import {
  childEnvironment,
  safeMarker
} from "./provider-core.mjs";
import {
  atomicPrivateFile,
  directoryIdentityMatches,
  ensureFreshCachedCredential,
  existingOwnedSessionDirectoryIdentity,
  existingPrivateDirectoryIdentity,
  freshCachedCredentialPayload,
  neutralizeIdentityBoundCredential,
  openOptionalPrivateCredentialTempHandle,
  privateDirectory,
  stageRevocableTaskCredential
} from "./provider-credentials.mjs";
import {
  assertControllerAuthorityOutsideBroadTemp,
  assertControllerGitCheckoutSafe,
  assertControllerGitSeparation,
  assertNoGitObjectAlternates,
  canonicalGitCommonDirectory,
  captureGitInfoAttributesBinding,
  controllerGitEnvironment,
  ensureGitWorktreesMetadataRoot,
  recaptureTrustedGitInstallation,
  sameGitInfoAttributesBinding,
  sameTrustedGitInstallation,
  trustedGitInstallation
} from "./provider-git-controller.mjs";
import {
  MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS,
  WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID,
  workerOwnerControllerProfileId
} from "./provider-worktree-contract.mjs";
import {
  WORKTREE_CLEANUP_PURPOSE,
  WORKTREE_INTEGRATION_PURPOSE
} from "./recursion-guard.mjs";
function prepareWorkerOwnerControllerAuthority({
  stateDir,
  controlRoot,
  executionRoot,
  expectedGitCommonDir,
  baseCommit,
  targetPath,
  managedWorktreeParent,
  purpose,
  home,
  grokHome,
  lineage,
  profileId
}) {
  privateDirectory(home);
  privateDirectory(grokHome);
  const controllerCwd = path.join(home, "controller-cwd");
  privateDirectory(controllerCwd);
  const sourceRoot = fs.realpathSync(controlRoot);
  const workerRoot = fs.realpathSync(executionRoot);
  if (sourceRoot !== controlRoot
    || workerRoot !== executionRoot
    || sourceRoot === workerRoot) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Worker owner-controller roots are aliased or not distinct."
    );
  }
  const trustedPath = process.env.PATH;
  const gitInstallation = trustedGitInstallation(sourceRoot, trustedPath);
  const discoveredGitCommonDir = canonicalGitCommonDirectory(
    gitInstallation,
    sourceRoot
  );
  const executionGitCommonDir = canonicalGitCommonDirectory(
    gitInstallation,
    workerRoot
  );
  if (typeof expectedGitCommonDir !== "string"
    || !path.isAbsolute(expectedGitCommonDir)
    || path.normalize(expectedGitCommonDir) !== expectedGitCommonDir
    || fs.realpathSync(expectedGitCommonDir) !== discoveredGitCommonDir
    || executionGitCommonDir !== discoveredGitCommonDir) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Worker owner-controller Git common directory is not exact."
    );
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit || "")) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Worker owner-controller requires one exact base commit."
    );
  }
  let effectTarget;
  if (purpose === WORKTREE_INTEGRATION_PURPOSE) {
    const expectedTarget = path.join(sourceRoot, "target.txt");
    if (targetPath !== expectedTarget
      || fs.realpathSync(targetPath) !== expectedTarget) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Worker integration authority is not the exact control target.txt."
      );
    }
    const target = fs.lstatSync(expectedTarget);
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Worker integration target is not a regular file."
      );
    }
    effectTarget = expectedTarget;
  } else {
    const expectedParent = path.dirname(workerRoot);
    if (managedWorktreeParent !== expectedParent
      || fs.realpathSync(managedWorktreeParent) !== expectedParent) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Worker cleanup authority is not the exact managed worktree parent."
      );
    }
    const parent = fs.lstatSync(expectedParent);
    if (!parent.isDirectory()
      || parent.isSymbolicLink()
      || (parent.mode & 0o077) !== 0) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Worker cleanup parent is aliased, shared, or not private."
      );
    }
    effectTarget = expectedParent;
  }
  assertControllerAuthorityOutsideBroadTemp({
    controlRoot: sourceRoot,
    gitCommonDir: discoveredGitCommonDir,
    stateDir,
    destinationParent: effectTarget
  });
  assertControllerGitSeparation({
    gitInstallation,
    controlRoot: sourceRoot,
    stateDir,
    home,
    destinationRoot: effectTarget
  });
  assertNoGitObjectAlternates(discoveredGitCommonDir);
  const gitWorktreesMetadataRoot = ensureGitWorktreesMetadataRoot(
    discoveredGitCommonDir
  );
  const gitInfoAttributesBinding = captureGitInfoAttributesBinding(
    discoveredGitCommonDir
  );
  assertControllerGitCheckoutSafe({
    gitExecutable: gitInstallation.executable,
    gitExecutableDirectory: gitInstallation.executableDirectory,
    gitInstallationRoot: gitInstallation.installationRoot,
    workspaceRoot: sourceRoot,
    baseCommit
  });
  const sandboxProfile = `companion_${crypto.createHash("sha256").update(
    `${lineage}:${profileId}:${purpose}`
  ).digest("hex").slice(0, 20)}`;
  // Grok Build's custom sandbox profile accepts directories, not individual
  // files. The integration controller is no-model, pinned, and method-limited
  // to the official worktree apply extension; the exact one-file artifact is
  // independently verified before and after that call.
  const readWrite = purpose === WORKTREE_INTEGRATION_PURPOSE
    ? [sourceRoot]
    : [effectTarget, gitWorktreesMetadataRoot];
  const readOnly = [
    sourceRoot,
    workerRoot,
    discoveredGitCommonDir,
    gitInstallation.installationRoot
  ].filter((value, index, values) => (
    values.indexOf(value) === index && !readWrite.includes(value)
  ));
  atomicPrivateFile(
    path.join(grokHome, "config.toml"),
    `[skills]\nignore = [${JSON.stringify(sourceRoot)}, ${JSON.stringify(workerRoot)}]\n\n[subagents]\nenabled = false\n\n[features]\nlsp_tools = false\n`
  );
  atomicPrivateFile(
    path.join(grokHome, "sandbox.toml"),
    [
      `[profiles.${sandboxProfile}]`,
      'extends = "strict"',
      "restrict_network = true",
      `read_only = [${readOnly.map((item) => JSON.stringify(item)).join(", ")}]`,
      `read_write = [${readWrite.map((item) => JSON.stringify(item)).join(", ")}]`,
      "deny = []",
      ""
    ].join("\n")
  );
  return {
    controllerCwd,
    sourceRoot,
    workerRoot,
    gitInstallation,
    discoveredGitCommonDir,
    gitWorktreesMetadataRoot,
    gitInfoAttributesBinding,
    sandboxProfile,
    effectTarget
  };
}

/**
 * Construct a fresh, purpose-specific home for a no-model owner controller.
 * Integration may write only controlRoot/target.txt. Cleanup may write only
 * the exact managed worker parent and Git's linked-worktree admin directory.
 */
export function workerOwnerControllerEnvironment(
  stateDir,
  controlRoot,
  executionRoot,
  {
    purpose,
    homeMarker,
    gitCommonDir: expectedGitCommonDir,
    baseCommit,
    targetPath = null,
    managedWorktreeParent = null
  } = {}
) {
  const profileId = workerOwnerControllerProfileId(purpose);
  const lineage = safeMarker(homeMarker);
  if (!lineage || lineage !== homeMarker) {
    throw new CompanionError(
      "E_STATE",
      "Worker owner-controller requires an exact private home marker."
    );
  }
  const home = path.join(stateDir, "task-homes", lineage);
  const grokHome = path.join(home, ".grok");
  let homeCreated = false;
  let stagedCredential = null;
  let credentialRevoked = false;
  try {
    privateDirectory(path.dirname(home));
    try {
      fs.mkdirSync(home, { mode: 0o700 });
      homeCreated = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new CompanionError(
          "E_STATE",
          "Worker owner-controller claim home already exists."
        );
      }
      throw error;
    }
    const {
      controllerCwd,
      sourceRoot,
      workerRoot,
      gitInstallation,
      discoveredGitCommonDir,
      gitWorktreesMetadataRoot,
      gitInfoAttributesBinding,
      sandboxProfile,
      effectTarget
    } = prepareWorkerOwnerControllerAuthority({
      stateDir,
      controlRoot,
      executionRoot,
      expectedGitCommonDir,
      baseCommit,
      targetPath,
      managedWorktreeParent,
      purpose,
      home,
      grokHome,
      lineage,
      profileId
    });
    const authPath = process.env.GROK_AUTH_PATH
      || path.join(os.homedir(), ".grok", "auth.json");
    if (!fs.existsSync(authPath)) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        `Grok cached authentication is unavailable. Run \`grok login\`, then ${hostCommand("setup")}.`
      );
    }
    const authFile = path.join(grokHome, "auth.json");
    const directoryIdentities = [home, grokHome].map(
      existingPrivateDirectoryIdentity
    );
    const knownSecrets = [];
    const gitEnv = controllerGitEnvironment(gitInstallation);
    const env = childEnvironment({
      ...gitEnv,
      HOME: home,
      USERPROFILE: home,
      GROK_HOME: grokHome,
      GROK_FOLDER_TRUST: "1",
      PATH: gitInstallation.executableDirectory,
      GROK_SUBAGENTS: "0",
      GROK_MEMORY: "0",
      GROK_WEB_FETCH: "0",
      GROK_LSP_TOOLS: "0"
    });
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
    const assertCredentialAbsent = () => {
      if (!directoryIdentities.every(directoryIdentityMatches)) {
        throw new CompanionError(
          "E_STATE",
          "Worker owner-controller credential parent changed."
        );
      }
      try {
        fs.lstatSync(authFile);
        throw new CompanionError(
          "E_STATE",
          "Worker owner-controller credential remained after initialization."
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    };
    const assertHomeAbsent = () => {
      try {
        fs.lstatSync(home);
        throw new CompanionError(
          "E_STATE",
          "Worker owner-controller home remained after teardown."
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return true;
    };
    return Object.freeze({
      purpose,
      profileId,
      home,
      grokHome,
      controllerCwd,
      sandboxProfile,
      env,
      knownSecrets,
      gitCommonDir: discoveredGitCommonDir,
      gitWorktreesMetadataRoot,
      gitExecutable: gitInstallation.executable,
      gitExecutableDirectory: gitInstallation.executableDirectory,
      gitExecutableDigest: gitInstallation.executableDigest,
      effectTarget,
      stageCredential() {
        if (credentialRevoked) {
          throw new CompanionError(
            "E_STATE",
            "A revoked owner-controller credential cannot be restaged."
          );
        }
        if (stagedCredential) return;
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
          if (credentialRevoked) return;
          try { stagedCredential.refresh(); }
          catch (error) { if (error?.code !== "ENOENT") throw error; }
          stagedCredential.revoke();
          credentialRevoked = true;
          return;
        }
        try { fs.unlinkSync(authFile); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      },
      assertCredentialAbsent,
      assertHomeAbsent,
      verifyGitExecutable() {
        const current = recaptureTrustedGitInstallation(gitInstallation);
        if (!sameTrustedGitInstallation(gitInstallation, current)
          || !sameGitInfoAttributesBinding(
            gitInfoAttributesBinding,
            captureGitInfoAttributesBinding(discoveredGitCommonDir)
          )) {
          throw new CompanionError(
            "E_CAPABILITY",
            "Worker owner-controller Git authority changed."
          );
        }
        assertNoGitObjectAlternates(discoveredGitCommonDir);
        assertControllerGitCheckoutSafe({
          gitExecutable: current.executable,
          gitExecutableDirectory: current.executableDirectory,
          gitInstallationRoot: current.installationRoot,
          workspaceRoot: sourceRoot,
          baseCommit
        });
        return current;
      },
      cleanup(processIdentity) {
        if (processIdentity && !processGroupGone(processIdentity)) {
          throw new CompanionError(
            "E_PROCESS_IDENTITY",
            "Worker owner-controller home cannot be removed while its process group may live."
          );
        }
        assertCredentialAbsent();
        if (!directoryIdentities.every(directoryIdentityMatches)) {
          throw new CompanionError(
            "E_STATE",
            "Worker owner-controller home identity changed before teardown."
          );
        }
        fs.rmSync(home, { recursive: true, force: true });
        return assertHomeAbsent();
      }
    });
  } catch (error) {
    let cleanupFailure = null;
    try { stagedCredential?.revoke(); }
    catch (failure) { cleanupFailure = failure; }
    try {
      if (homeCreated) fs.rmSync(home, { recursive: true, force: true });
    } catch (failure) {
      cleanupFailure ||= failure;
    }
    if (cleanupFailure) {
      throw new CompanionError(
        "E_STATE",
        "Failed owner-controller environment could not be removed transactionally.",
        { causeCode: error?.code || null }
      );
    }
    throw error;
  }
}

function prepareSessionCloseControllerRuntime(
  stateDir,
  providerLineage,
  controllerLineage
) {
  const taskHomes = path.join(stateDir, "task-homes");
  const lineageHome = path.join(taskHomes, providerLineage);
  const grokHome = path.join(lineageHome, ".grok");
  const sessions = path.join(grokHome, "sessions");
  const home = path.join(taskHomes, controllerLineage);
  const controllerCwd = path.join(home, "controller-cwd");
  const authFile = path.join(grokHome, "auth.json");
  const sessionHomeIdentities = Object.freeze([
    existingPrivateDirectoryIdentity(taskHomes),
    existingPrivateDirectoryIdentity(lineageHome),
    existingPrivateDirectoryIdentity(grokHome),
    existingOwnedSessionDirectoryIdentity(sessions)
  ]);
  const sessionHomeIdentityDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(sessionHomeIdentities))
    .digest("hex");
  const verifySessionHome = () => {
    if (!sessionHomeIdentities.every(directoryIdentityMatches)) {
      throw new CompanionError(
        "E_STATE",
        "Worker provider-session home identity changed."
      );
    }
    return sessionHomeIdentityDigest;
  };
  const assertNoForeignProviderAuthTemporaries = (
    allowedProviderPid = null
  ) => {
    verifySessionHome();
    const allowed = allowedProviderPid == null
      ? null
      : `auth.json.${allowedProviderPid}.tmp`;
    const foreign = fs.readdirSync(grokHome).find((entry) => (
      /^auth\.json\.[1-9]\d*\.tmp$/.test(entry) && entry !== allowed
    ));
    if (foreign) {
      throw new CompanionError(
        "E_STATE",
        "Worker provider-session home contains a foreign credential temporary file."
      );
    }
  };
  const assertProviderSessionCredentialAbsent = () => {
    verifySessionHome();
    try {
      fs.lstatSync(authFile);
      throw new CompanionError(
        "E_STATE",
        "Worker provider-session credential already exists or remained after authentication."
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    assertNoForeignProviderAuthTemporaries();
    return true;
  };

  // Never take ownership of a lineage that still carries a reusable task
  // credential. In particular, do not unlink an unbound pre-existing file.
  assertProviderSessionCredentialAbsent();

  const ephemeralIdentities = [];
  let stagedCredential = null;
  let credentialRevoked = false;
  let credentialWriterIdentity = null;
  const knownSecrets = [];
  const bindCredentialWriterIdentity = (processIdentity) => {
    assertCompleteDetachedOwnedIdentity(processIdentity);
    if (!Number.isSafeInteger(processIdentity?.providerPid)
      || processIdentity.providerPid <= 0
      || !processGroupGone(processIdentity)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Worker provider credential cannot be removed while its exact controller process group may live."
      );
    }
    const candidate = Object.freeze({
      pid: processIdentity.pid,
      startToken: processIdentity.startToken,
      processGroupId: processIdentity.processGroupId,
      providerPid: processIdentity.providerPid
    });
    if (credentialWriterIdentity
      && (credentialWriterIdentity.pid !== candidate.pid
        || credentialWriterIdentity.startToken !== candidate.startToken
        || credentialWriterIdentity.processGroupId !== candidate.processGroupId
        || credentialWriterIdentity.providerPid !== candidate.providerPid)) {
      throw new CompanionError(
        "E_PROCESS_IDENTITY",
        "Worker provider credential writer identity changed during cleanup."
      );
    }
    credentialWriterIdentity ||= candidate;
    return credentialWriterIdentity;
  };
  const providerAuthTemporary = (processIdentity) => (
    `${authFile}.${bindCredentialWriterIdentity(processIdentity).providerPid}.tmp`
  );
  const assertCredentialPathAbsent = (credentialFile, message) => {
    try {
      fs.lstatSync(credentialFile);
      throw new CompanionError("E_STATE", message);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  const assertHomeAbsent = () => {
    try {
      fs.lstatSync(home);
      throw new CompanionError(
        "E_STATE",
        "Worker session-close controller home remained after teardown."
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return true;
  };
  const removeEphemeralHome = () => {
    verifySessionHome();
    if (!ephemeralIdentities.length
      || !ephemeralIdentities.every(directoryIdentityMatches)) {
      throw new CompanionError(
        "E_STATE",
        "Worker session-close controller home identity changed before teardown."
      );
    }
    fs.rmSync(home, { recursive: true, force: true });
    assertHomeAbsent();
    verifySessionHome();
    return true;
  };
  return {
    grokHome,
    home,
    controllerCwd,
    ephemeralIdentities,
    knownSecrets,
    sessionHomeIdentityDigest,
    verifySessionHome,
    assertHomeAbsent,
    removeEphemeralHome,
    stageCredential() {
      if (credentialRevoked) {
        throw new CompanionError(
          "E_STATE",
          "A revoked session-close controller credential cannot be restaged."
        );
      }
      if (stagedCredential) return;
      assertProviderSessionCredentialAbsent();
      const authPath = process.env.GROK_AUTH_PATH
        || path.join(os.homedir(), ".grok", "auth.json");
      if (!fs.existsSync(authPath)) {
        throw new CompanionError(
          "E_AUTH_REQUIRED",
          `Grok cached authentication is unavailable. Run \`grok login\`, then ${hostCommand("setup")}.`
        );
      }
      const payload = freshCachedCredentialPayload(
        authPath,
        MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS
      );
      stagedCredential = stageRevocableTaskCredential(
        authPath,
        authFile,
        sessionHomeIdentities,
        payload
      );
      knownSecrets.push(stagedCredential.key);
    },
    revokeCredential(processIdentity) {
      verifySessionHome();
      if (!stagedCredential) {
        assertProviderSessionCredentialAbsent();
        return;
      }
      const temporary = providerAuthTemporary(processIdentity);
      assertNoForeignProviderAuthTemporaries(
        credentialWriterIdentity.providerPid
      );
      if (!credentialRevoked) {
        // Bind and validate the one upstream temp path before touching either
        // credential. Never glob: auth.json.lock and unrelated files remain
        // outside this controller's authority.
        const temporaryHandle = openOptionalPrivateCredentialTempHandle(
          temporary
        );
        try {
          try { stagedCredential.refresh(); }
          catch (error) { if (error?.code !== "ENOENT") throw error; }
          neutralizeIdentityBoundCredential(
            temporary,
            sessionHomeIdentities,
            temporaryHandle
          );
          stagedCredential.revoke();
        } catch (error) {
          if (temporaryHandle?.descriptor != null) {
            try { fs.closeSync(temporaryHandle.descriptor); }
            catch { /* retain artifacts and surface the primary failure */ }
            temporaryHandle.descriptor = null;
          }
          throw error;
        }
        credentialRevoked = true;
      }
      assertProviderSessionCredentialAbsent(credentialWriterIdentity);
    },
    assertCredentialAbsent(processIdentity = null) {
      assertProviderSessionCredentialAbsent();
      if (stagedCredential) {
        const exactIdentity = processIdentity
          ? bindCredentialWriterIdentity(processIdentity)
          : credentialWriterIdentity;
        if (!exactIdentity) {
          throw new CompanionError(
            "E_PROCESS_IDENTITY",
            "Worker provider credential absence requires its exact writer identity."
          );
        }
        assertCredentialPathAbsent(
          `${authFile}.${exactIdentity.providerPid}.tmp`,
          "Worker provider credential temporary file remained after authentication."
        );
      }
      return true;
    }
  };
}

/**
 * Construct a close-only controller around one existing provider lineage.
 *
 * The controller receives a fresh private HOME/CWD, while GROK_HOME remains
 * bound to the exact lineage that owns the provider's local session store.
 * No lineage configuration or sandbox file is rewritten: the controller uses
 * Grok Build's built-in strict sandbox and its caller exposes only the
 * initialize/authenticate/load/close ACP surface.
 */
export function workerSessionCloseControllerEnvironment(
  stateDir,
  providerHomeId,
  { homeMarker } = {}
) {
  if (typeof stateDir !== "string"
    || !path.isAbsolute(stateDir)
    || path.normalize(stateDir) !== stateDir) {
    throw new CompanionError(
      "E_STATE",
      "Worker session-close controller requires one exact state directory."
    );
  }
  const providerLineage = safeMarker(providerHomeId);
  const controllerLineage = safeMarker(homeMarker);
  if (!providerLineage
    || providerLineage !== providerHomeId
    || !controllerLineage
    || controllerLineage !== homeMarker
    || providerLineage === controllerLineage) {
    throw new CompanionError(
      "E_STATE",
      "Worker session-close controller requires distinct exact home markers."
    );
  }

  const runtime = prepareSessionCloseControllerRuntime(
    stateDir,
    providerLineage,
    controllerLineage
  );
  const {
    grokHome,
    home,
    controllerCwd,
    ephemeralIdentities,
    knownSecrets,
    sessionHomeIdentityDigest,
    verifySessionHome,
    assertHomeAbsent,
    removeEphemeralHome
  } = runtime;
  let homeCreated = false;

  try {
    try {
      fs.mkdirSync(home, { mode: 0o700 });
      homeCreated = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new CompanionError(
          "E_STATE",
          "Worker session-close controller claim home already exists."
        );
      }
      throw error;
    }
    ephemeralIdentities.push(existingPrivateDirectoryIdentity(home));
    fs.mkdirSync(controllerCwd, { mode: 0o700 });
    ephemeralIdentities.push(existingPrivateDirectoryIdentity(controllerCwd));
    verifySessionHome();

    const env = childEnvironment({
      HOME: home,
      USERPROFILE: home,
      GROK_HOME: grokHome,
      GROK_FOLDER_TRUST: "1",
      GROK_SUBAGENTS: "0",
      GROK_MEMORY: "0",
      GROK_WEB_FETCH: "0",
      GROK_LSP_TOOLS: "0",
      GROK_WORKSPACE_TOOL_DEFS_ENABLED: "0"
    });
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
    delete env.GROK_AUTH_PATH;

    return Object.freeze({
      purpose: WORKTREE_CLEANUP_PURPOSE,
      profileId: WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID,
      home,
      grokHome,
      controllerCwd,
      sandboxProfile: "strict",
      env,
      knownSecrets,
      sessionHomeIdentityDigest,
      verifySessionHome,
      stageCredential: runtime.stageCredential,
      revokeCredential: runtime.revokeCredential,
      assertCredentialAbsent: runtime.assertCredentialAbsent,
      assertHomeAbsent,
      cleanup(processIdentity) {
        if (processIdentity && !processGroupGone(processIdentity)) {
          throw new CompanionError(
            "E_PROCESS_IDENTITY",
            "Worker session-close controller home cannot be removed while its process group may live."
          );
        }
        this.assertCredentialAbsent(processIdentity);
        return removeEphemeralHome();
      }
    });
  } catch (error) {
    let cleanupFailure = null;
    try {
      if (homeCreated) removeEphemeralHome();
    } catch (failure) {
      cleanupFailure = failure;
    }
    if (cleanupFailure) {
      throw new CompanionError(
        "E_STATE",
        "Failed session-close controller environment could not be removed transactionally.",
        { causeCode: error?.code || null }
      );
    }
    throw error;
  }
}

/**
 * Stage only a short-lived credential in an existing isolated task home.
 * Qualification cleanup uses this after the provider runtime has already
 * removed its execution credential; it must not rewrite task configuration or
 * sandbox policy while proving provider-session deletion.
 */
export function taskCredentialEnvironment(
  stateDir,
  homeMarker = "task",
  { providerExecutableBinary = null } = {}
) {
  const lineage = safeMarker(homeMarker);
  if (!lineage || lineage !== homeMarker) {
    throw new CompanionError("E_STATE", "A qualified isolated task home is required.");
  }
  const home = path.join(stateDir, "task-homes", lineage);
  const grokHome = path.join(home, ".grok");
  const directoryIdentities = [home, grokHome]
    .map(existingPrivateDirectoryIdentity);
  const authPath = process.env.GROK_AUTH_PATH
    || path.join(os.homedir(), ".grok", "auth.json");
  if (!fs.existsSync(authPath)) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      `Grok cached authentication is unavailable. Run \`grok login\`, then ${hostCommand("setup")}.`
    );
  }
  ensureFreshCachedCredential(
    authPath,
    45 * 60 * 1000,
    providerExecutableBinary
  );
  const authFile = path.join(grokHome, "auth.json");
  try {
    fs.lstatSync(authFile);
    throw new CompanionError("E_STATE", "The isolated task credential was not revoked before staging.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const credential = stageRevocableTaskCredential(
    authPath,
    authFile,
    directoryIdentities
  );
  const knownSecrets = [credential.key];
  const env = childEnvironment({
    HOME: home,
    USERPROFILE: home,
    GROK_HOME: grokHome,
    GROK_FOLDER_TRUST: "1",
    GROK_SUBAGENTS: "0",
    GROK_MEMORY: "0",
    GROK_WEB_FETCH: "0",
    GROK_LSP_TOOLS: "0"
  });
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  delete env.GROK_AUTH_PATH;
  return {
    env,
    home,
    grokHome,
    knownSecrets,
    refreshCredentialHandle() {
      credential.refresh();
    },
    revokeCredential() {
      credential.revoke();
    }
  };
}

export function revokeTaskCredential(stateDir, homeMarker) {
  const file = path.join(stateDir, "task-homes", safeMarker(homeMarker), ".grok", "auth.json");
  try { fs.unlinkSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

/** Remove only transient task credentials/profiles, preserving resumable session data. */
export function cleanupTaskRuntimeArtifacts(stateDir, homeMarker, identities = []) {
  const recorded = (Array.isArray(identities) ? identities : [identities]).filter(Boolean);
  if (recorded.some((identity) => !processGroupGone(identity))) {
    return { ok: false, warning: "Task runtime artifacts retained because process cleanup could not be verified." };
  }

  const grokHome = path.join(stateDir, "task-homes", safeMarker(homeMarker), ".grok");
  const warnings = [];
  try { revokeTaskCredential(stateDir, homeMarker); }
  catch (error) { warnings.push(`credential cleanup failed (${error?.code || "unknown"})`); }

  const profiles = path.join(grokHome, "agent-profiles");
  try {
    const stat = fs.lstatSync(profiles);
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(profiles, { recursive: true, force: true });
    else fs.unlinkSync(profiles);
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push(`agent-profile cleanup failed (${error?.code || "unknown"})`);
  }
  return warnings.length
    ? { ok: false, warning: `Task runtime artifacts retained: ${warnings.join("; ")}.` }
    : { ok: true };
}
