import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CompanionError } from "./errors.mjs";
import { hostCommand } from "./host.mjs";
import { processGroupGone } from "./process-control.mjs";
import { redactText } from "./redact.mjs";
import {
  childEnvironment,
  discoverGrok,
  safeMarker
} from "./provider-core.mjs";
import {
  MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS
} from "./provider-worktree-contract.mjs";

export function authEntryExpiries(parsed) {
  return Object.values(parsed || {})
    .flatMap((entry) => (
      entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16 && entry.expires_at
        ? [Date.parse(entry.expires_at)]
        : []
    ))
    .filter(Number.isFinite);
}

/**
 * Ensure the cached auth file has enough validity for an isolated job.
 * When `source` is not the default `~/.grok/auth.json` (e.g. CI staged path via
 * GROK_AUTH_PATH), refresh must use a temporary HOME that carries that file so
 * `grok models` can rotate the staged session and write the result back.
 */
export function ensureFreshCachedCredential(
  source,
  minimumValidityMs = 45 * 60 * 1000,
  providerBinary = null
) {
  const sourcePath = path.resolve(source);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")); }
  catch { throw new CompanionError("E_AUTH_REQUIRED", `Grok cached authentication is unreadable. Run \`grok login\`, then ${hostCommand("setup")}.`); }
  const expiries = authEntryExpiries(parsed);
  if (!expiries.length || Math.max(...expiries) - Date.now() >= minimumValidityMs) return;

  const defaultAuth = path.resolve(path.join(os.homedir(), ".grok", "auth.json"));
  let refreshEnv = childEnvironment();
  let tempHome = null;
  try {
    if (sourcePath !== defaultAuth) {
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-refresh-"));
      const grokHome = path.join(tempHome, ".grok");
      fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
      const staged = path.join(grokHome, "auth.json");
      fs.copyFileSync(sourcePath, staged);
      fs.chmodSync(staged, 0o600);
      refreshEnv = childEnvironment({
        HOME: tempHome,
        USERPROFILE: tempHome,
        GROK_HOME: grokHome,
        GROK_AUTH_PATH: staged
      });
    }

    const refreshed = spawnSync(providerBinary || discoverGrok(), ["models"], {
      encoding: "utf8",
      shell: false,
      timeout: 30000,
      env: refreshEnv
    });
    if (refreshed.status !== 0 || refreshed.error) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        `Grok cached authentication could not be refreshed. Run \`grok login\`, then ${hostCommand("setup")}.`
      );
    }

    if (tempHome) {
      const refreshedAuth = path.join(tempHome, ".grok", "auth.json");
      if (fs.existsSync(refreshedAuth)) {
        fs.copyFileSync(refreshedAuth, sourcePath);
        fs.chmodSync(sourcePath, 0o600);
      }
    }

    try { parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")); }
    catch {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        `Grok cached authentication is unreadable after refresh. Run \`grok login\`, then ${hostCommand("setup")}.`
      );
    }
    const refreshedExpiries = authEntryExpiries(parsed);
    // After a successful `grok models` call the CLI accepted the credential. Isolated
    // review jobs are short-lived; require a small remaining window rather than a full
    // 45-minute buffer when the provider did not extend expires_at.
    const postRefreshFloorMs = Math.min(
      minimumValidityMs,
      MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS
    );
    if (refreshedExpiries.length && Math.max(...refreshedExpiries) - Date.now() < postRefreshFloorMs) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        `Grok cached authentication expires too soon for an isolated job. Run \`grok login\`, then ${hostCommand("setup")}.`
      );
    }
  } finally {
    if (tempHome) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
export function freshCachedCredentialPayload(
  source,
  minimumValidityMs = 45 * 60 * 1000
) {
  const payload = isolatedCredentialPayload(source);
  const expiry = Date.parse(payload.expiresAt);
  if (Number.isFinite(expiry)
    && expiry - Date.now() < minimumValidityMs) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      `Grok cached authentication expires too soon for an isolated job. Run \`grok login\`, then ${hostCommand("setup")}.`
    );
  }
  return payload;
}

export function isolatedCredentialPayload(source) {
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) throw new CompanionError("E_AUTH_REQUIRED", `Grok cached authentication is unavailable. Run \`grok login\`, then ${hostCommand("setup")}.`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(source, "utf8")); }
  catch { throw new CompanionError("E_AUTH_REQUIRED", `Grok cached authentication is unreadable. Run \`grok login\`, then ${hostCommand("setup")}.`); }
  const candidates = Object.entries(parsed || {}).filter(([, entry]) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16);
  const selected = candidates.sort(([, left], [, right]) => String(right.expires_at || "").localeCompare(String(left.expires_at || "")))[0];
  if (!selected) throw new CompanionError("E_AUTH_REQUIRED", `Grok cached authentication contains no usable session. Run \`grok login\`, then ${hostCommand("setup")}.`);
  const [account, entry] = selected;
  const isolated = { key: entry.key, auth_mode: entry.auth_mode || "oauth", create_time: entry.create_time || new Date().toISOString(), user_id: "", email: "", first_name: "", last_name: "", profile_image_asset_id: "", principal_type: entry.principal_type || "", principal_id: entry.principal_id || "", team_id: entry.team_id || "", coding_data_retention_opt_out: Boolean(entry.coding_data_retention_opt_out), refresh_token: "", expires_at: entry.expires_at || "", oidc_issuer: entry.oidc_issuer || "", oidc_client_id: entry.oidc_client_id || "" };
  return {
    key: entry.key,
    expiresAt: entry.expires_at || "",
    contents: `${JSON.stringify({ [account]: isolated })}\n`
  };
}

export function writeReviewCredential(source, destination, { refresh = false } = {}) {
  if (!refresh && fs.existsSync(destination)) {
    if (!fs.lstatSync(destination).isFile()) throw new CompanionError("E_STATE", "The isolated Grok credential path is not a regular file.");
    try {
      const existing = JSON.parse(fs.readFileSync(destination, "utf8"));
      const key = Object.values(existing || {}).find((entry) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length >= 16)?.key;
      if (key) return key;
    } catch {}
    throw new CompanionError("E_AUTH_REQUIRED", `The isolated Grok credential is unreadable. Run \`grok login\`, then ${hostCommand("setup")}.`);
  }
  const payload = isolatedCredentialPayload(source);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, payload.contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return payload.key;
}

export function existingPrivateDirectoryIdentity(directory) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || fs.realpathSync(resolved) !== resolved
  ) {
    throw new CompanionError("E_STATE", "The isolated task home is unsafe.");
  }
  return Object.freeze({
    path: resolved,
    device: String(stat.dev),
    inode: String(stat.ino)
  });
}

export function existingOwnedSessionDirectoryIdentity(directory) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o022) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || fs.realpathSync(resolved) !== resolved
  ) {
    throw new CompanionError("E_STATE", "The isolated provider session directory is unsafe.");
  }
  return Object.freeze({
    path: resolved,
    device: String(stat.dev),
    inode: String(stat.ino),
    policy: "owned-session-directory"
  });
}

export function directoryIdentityMatches(identity) {
  try {
    const current = identity?.policy === "owned-session-directory"
      ? existingOwnedSessionDirectoryIdentity(identity.path)
      : existingPrivateDirectoryIdentity(identity.path);
    return current.device === identity.device && current.inode === identity.inode;
  } catch {
    return false;
  }
}

export function sameFileIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

export function privateCredentialIdentity(stat) {
  if (
    !stat.isFile()
    || stat.isSymbolicLink?.()
    || stat.size <= 0
    || stat.size > 2 * 1024 * 1024
    || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new CompanionError("E_STATE", "The isolated task credential is unsafe.");
  }
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino)
  });
}

export function openPrivateCredentialHandle(authFile) {
  let descriptor = null;
  try {
    const before = fs.lstatSync(authFile);
    const identity = privateCredentialIdentity(before);
    descriptor = fs.openSync(
      authFile,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = fs.fstatSync(descriptor);
    const openedIdentity = privateCredentialIdentity(opened);
    const afterIdentity = privateCredentialIdentity(fs.lstatSync(authFile));
    if (
      !sameFileIdentity(identity, openedIdentity)
      || !sameFileIdentity(identity, afterIdentity)
    ) {
      throw new CompanionError("E_STATE", "The isolated task credential changed during binding.");
    }
    return { descriptor, identity };
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* best-effort */ }
    }
    throw error;
  }
}

export function privateCredentialTempIdentity(stat) {
  if (
    !stat.isFile()
    || stat.isSymbolicLink?.()
    || stat.size > 2 * 1024 * 1024
    || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new CompanionError(
      "E_STATE",
      "The isolated provider credential temporary file is unsafe."
    );
  }
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino)
  });
}

export function openOptionalPrivateCredentialTempHandle(temporary) {
  let descriptor = null;
  try {
    const before = fs.lstatSync(temporary);
    const identity = privateCredentialTempIdentity(before);
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0)
    );
    const openedIdentity = privateCredentialTempIdentity(
      fs.fstatSync(descriptor)
    );
    const afterIdentity = privateCredentialTempIdentity(
      fs.lstatSync(temporary)
    );
    if (!sameFileIdentity(identity, openedIdentity)
      || !sameFileIdentity(identity, afterIdentity)) {
      throw new CompanionError(
        "E_STATE",
        "The isolated provider credential temporary file changed during binding."
      );
    }
    return { descriptor, identity };
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* best-effort */ }
    }
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function neutralizeCredentialHandle(handle) {
  if (!handle || handle.descriptor == null) return;
  let failure = null;
  try { fs.ftruncateSync(handle.descriptor, 0); }
  catch (error) { failure = error; }
  try { fs.fsyncSync(handle.descriptor); }
  catch (error) { failure ||= error; }
  try { fs.closeSync(handle.descriptor); }
  catch (error) { failure ||= error; }
  handle.descriptor = null;
  if (failure) throw failure;
}

export function neutralizeIdentityBoundCredential(
  credentialFile,
  directoryIdentities,
  handle
) {
  if (!handle) return;
  // If neutralization cannot be proven, retain the pathname for recovery
  // instead of unlinking a credential that may still contain secret bytes.
  neutralizeCredentialHandle(handle);
  unlinkIdentityBoundCredential(
    credentialFile,
    directoryIdentities,
    handle.identity
  );
}

export function unlinkIdentityBoundCredential(authFile, directoryIdentities, identity) {
  if (!directoryIdentities.every(directoryIdentityMatches)) {
    throw new CompanionError("E_STATE", "The isolated task credential parent changed during cleanup.");
  }
  let current;
  try {
    current = fs.lstatSync(authFile);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const currentIdentity = Object.freeze({
    device: String(current.dev),
    inode: String(current.ino)
  });
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || (current.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && current.uid !== process.getuid())
    || !sameFileIdentity(currentIdentity, identity)
  ) {
    throw new CompanionError("E_STATE", "The isolated task credential changed during cleanup.");
  }
  const rebound = fs.lstatSync(authFile);
  if (
    String(rebound.dev) !== identity.device
    || String(rebound.ino) !== identity.inode
  ) {
    throw new CompanionError("E_STATE", "The isolated task credential changed during cleanup.");
  }
  fs.unlinkSync(authFile);
  try {
    fs.lstatSync(authFile);
    throw new CompanionError("E_STATE", "The isolated task credential remained after cleanup.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function stageRevocableTaskCredential(
  source,
  authFile,
  directoryIdentities,
  payload = isolatedCredentialPayload(source)
) {
  const temporary = `${authFile}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let handle = null;
  let published = false;
  try {
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_RDWR
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    handle = { descriptor, identity: null };
    fs.writeFileSync(descriptor, payload.contents, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    handle.identity = privateCredentialIdentity(fs.fstatSync(descriptor));
    fs.linkSync(temporary, authFile);
    published = true;
    fs.unlinkSync(temporary);
    if (!directoryIdentities.every(directoryIdentityMatches)) {
      throw new CompanionError("E_STATE", "The isolated task credential parent changed during staging.");
    }
    const publishedIdentity = privateCredentialIdentity(fs.lstatSync(authFile));
    if (!sameFileIdentity(publishedIdentity, handle.identity)) {
      throw new CompanionError("E_STATE", "The isolated task credential changed during staging.");
    }
  } catch (error) {
    let cleanupFailure = null;
    try { neutralizeCredentialHandle(handle); }
    catch (cleanupError) { cleanupFailure = cleanupError; }
    if (published && handle?.identity) {
      try { fs.unlinkSync(temporary); }
      catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") cleanupFailure ||= cleanupError;
      }
      try {
        unlinkIdentityBoundCredential(
          authFile,
          directoryIdentities,
          handle.identity
        );
      } catch (cleanupError) {
        cleanupFailure ||= cleanupError;
      }
    } else {
      try { fs.unlinkSync(temporary); }
      catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") cleanupFailure ||= cleanupError;
      }
    }
    if (cleanupFailure) {
      throw new CompanionError("E_STATE", "The isolated task credential could not be neutralized.");
    }
    throw error;
  }

  let activeHandle = handle;
  let activeIdentity = handle.identity;
  let revoked = false;
  return {
    key: payload.key,
    refresh() {
      if (revoked) {
        throw new CompanionError("E_STATE", "The isolated task credential was already revoked.");
      }
      if (!directoryIdentities.every(directoryIdentityMatches)) {
        throw new CompanionError("E_STATE", "The isolated task credential parent changed during use.");
      }
      const next = openPrivateCredentialHandle(authFile);
      if (sameFileIdentity(next.identity, activeIdentity)) {
        fs.closeSync(next.descriptor);
        return;
      }
      const previous = activeHandle;
      activeHandle = next;
      activeIdentity = next.identity;
      neutralizeCredentialHandle(previous);
    },
    revoke() {
      if (revoked) return;
      let failure = null;
      const current = activeHandle;
      activeHandle = null;
      try { neutralizeCredentialHandle(current); }
      catch (error) { failure = error; }
      try {
        unlinkIdentityBoundCredential(
          authFile,
          directoryIdentities,
          activeIdentity
        );
      } catch (error) {
        failure ||= error;
      }
      if (failure) throw failure;
      revoked = true;
    }
  };
}

export function reviewEnvironment(
  stateDir,
  jobMarker,
  {
    includeCredential = true,
    providerExecutableBinary = null
  } = {}
) {
  const marker = safeMarker(jobMarker), home = path.join(stateDir, "review-homes", marker), grokHome = path.join(home, ".grok");
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  const sentinel = path.join(home, "sandbox-enforcement-sentinel"), profile = `companion_${crypto.createHash("sha256").update(marker).digest("hex").slice(0, 20)}`;
  if (!fs.existsSync(sentinel)) fs.writeFileSync(sentinel, "Review sandbox enforcement sentinel.\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(path.join(grokHome, "sandbox.toml"), `[profiles.${profile}]\nextends = "strict"\ndeny = [${JSON.stringify(sentinel)}]\n`, { mode: 0o600 });
  const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
  const extra = { HOME: home, USERPROFILE: home, GROK_HOME: grokHome, GROK_FOLDER_TRUST: "1" };
  const knownSecrets = [];
  if (includeCredential && fs.existsSync(authPath)) {
    ensureFreshCachedCredential(
      authPath,
      45 * 60 * 1000,
      providerExecutableBinary
    );
    knownSecrets.push(writeReviewCredential(authPath, path.join(grokHome, "auth.json")));
  }
  const env = childEnvironment(extra);
  delete env.HOMEDRIVE; delete env.HOMEPATH;
  return { env, home, grokHome, sandboxProfile: profile, knownSecrets };
}

export function cleanupReviewEnvironment(stateDir, jobMarker) {
  const home = path.join(stateDir, "review-homes", safeMarker(jobMarker));
  try { fs.rmSync(home, { recursive: true, force: true }); return { ok: true }; }
  catch (error) { return { ok: false, warning: redactText(error.message) }; }
}

/**
 * Remove an isolated review home only after the resolved provider process group is verified gone.
 * While a recorded group remains live or shutdown is unverifiable, retain the home and report a
 * privacy warning so callers never mark providerSessionDeleted true against a live credential.
 */
export function gatedCleanupReviewEnvironment(stateDir, jobMarker, identity) {
  if (identity && !processGroupGone(identity)) {
    return { ok: false, warning: "Isolated review home retained because process cleanup could not be verified." };
  }
  return cleanupReviewEnvironment(stateDir, jobMarker);
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CompanionError("E_STATE", `Refusing unsafe isolated Grok directory ${directory}.`);
  fs.chmodSync(directory, 0o700);
}

export function atomicPrivateFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
