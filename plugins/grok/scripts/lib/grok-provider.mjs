import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AcpClient,
  isCancelledPromptStopReason,
  isSuccessfulPromptStopReason
} from "./acp-client.mjs";
import { CompanionError } from "./errors.mjs";
import {
  assertExecutableAttestation,
  captureGrokExecutableIdentity,
  materializePinnedGrokExecutable,
  sameExecutableAttestation
} from "./executable-identity.mjs";
import { redact, redactText } from "./redact.mjs";
import { processGroupAlive, processGroupGone, processStartToken } from "./process-control.mjs";
import {
  assertWorkerOwnerControllerBinding,
  authenticateProviderBootstrapGuard,
  authenticateWorkerOwnerControllerBootstrapGuard,
  authenticateWorktreeProvisioningBootstrapGuard,
  loadProviderGuard,
  registerProviderGuard,
  unregisterProviderGuard,
  WORKTREE_CLEANUP_PURPOSE,
  WORKTREE_INTEGRATION_PURPOSE
} from "./recursion-guard.mjs";
import { hostCommand, hostContext, pluginDataRoot } from "./host.mjs";

export { processStartToken } from "./process-control.mjs";

const MIN_VERSION = [0, 2, 99];
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROVIDER_BOOTSTRAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "provider-bootstrap.mjs");
const PROVIDER_BOOTSTRAP_SPEC_FD = 6;
const MAX_PROVIDER_BOOTSTRAP_SPEC_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EXACT_NONCE_ID = /^[0-9a-f]{32}$/;
const OPAQUE_ID = /^[0-9a-f]{32,64}$/;
const WORKTREE_PROVISIONING_PURPOSE = "worktree-provisioning";
const WORKTREE_CONTROLLER_PROFILE_ID = "worktree-controller-v1";
export const WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID =
  "worktree-integration-controller-v1";
export const WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID =
  "worktree-cleanup-controller-v1";
const MIN_ISOLATED_STARTUP_CREDENTIAL_VALIDITY_MS = 2 * 60 * 1000;
const WORKTREE_CONTROLLER_REQUEST_ALLOWLIST = Object.freeze([
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
  "session/load",
  "_x.ai/session/close",
  "_x.ai/git/worktree/remove"
]);
const WORKTREE_PROVISIONING_BINDING_KEYS = new Set([
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
// One canonical provider-compatible schema. The public verdict is derived after validation.
export const REVIEW_SCHEMA = Object.freeze(JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8")
));
const ALLOW_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "NO_COLOR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT"]);

function exactRecord(value, keys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

function isWorktreeProvisioningBinding(binding) {
  return binding?.purpose === WORKTREE_PROVISIONING_PURPOSE;
}

function isWorkerOwnerControllerBinding(binding) {
  return binding?.purpose === WORKTREE_INTEGRATION_PURPOSE
    || binding?.purpose === WORKTREE_CLEANUP_PURPOSE;
}

function workerOwnerControllerProfileId(purpose) {
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

function validWorktreeProvisioningBinding(binding, root = null) {
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

/** Hard-gate for every provider execution entry. Prefer this over process-identity errors on unsupported platforms. */
export function assertProviderPlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new CompanionError("E_CAPABILITY", "Grok provider execution is disabled on Windows until process identity and forced-cleanup behavior are authenticated end to end. Provider-neutral validation remains available.");
  }
}

function executable(file) { try { const stat = fs.statSync(file); fs.accessSync(file, fs.constants.X_OK); return stat.isFile(); } catch { return false; } }
function which(name) { const run = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", shell: false, timeout: 5000 }); return run.status === 0 ? String(run.stdout).split(/\r?\n/)[0].trim() : null; }

export function discoverGrok() {
  for (const candidate of [process.env.GROK_BIN, which("grok"), path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")]) if (candidate && executable(candidate)) return fs.realpathSync(candidate);
  throw new CompanionError("E_GROK_NOT_FOUND", `Grok Build CLI was not found. Install it with \`npm install -g @xai-official/grok\`, then run ${hostCommand("setup")}.`);
}

export function grokVersion(binary = discoverGrok()) {
  const run = spawnSync(binary, ["--version"], { encoding: "utf8", shell: false, timeout: 10000, env: childEnvironment() });
  const match = `${run.stdout || ""} ${run.stderr || ""}`.match(/(\d+)\.(\d+)\.(\d+)/);
  if (run.status !== 0 || !match) throw new CompanionError("E_GROK_VERSION", "Could not determine the Grok CLI version.");
  const parts = match.slice(1).map(Number);
  if (parts.some((v, i) => v < MIN_VERSION[i] && parts.slice(0, i).every((x, j) => x === MIN_VERSION[j]))) throw new CompanionError("E_GROK_VERSION", `Grok ${match[0]} is too old; 0.2.99 or newer is required.`);
  return match[0];
}

export function childEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if ((ALLOW_ENV.has(key) || key.startsWith("LC_")) && value != null) env[key] = value;
  return {
    ...env,
    GROK_COMPANION_CHILD: "1",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CLAUDE_SKILLS_ENABLED: "false",
    GROK_CLAUDE_RULES_ENABLED: "false",
    GROK_CLAUDE_AGENTS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CLAUDE_SESSIONS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CURSOR_SKILLS_ENABLED: "false",
    GROK_CURSOR_RULES_ENABLED: "false",
    GROK_CURSOR_AGENTS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_CURSOR_SESSIONS_ENABLED: "false",
    GROK_CODEX_MCPS_ENABLED: "false",
    GROK_CODEX_SKILLS_ENABLED: "false",
    GROK_CODEX_RULES_ENABLED: "false",
    GROK_CODEX_AGENTS_ENABLED: "false",
    GROK_CODEX_HOOKS_ENABLED: "false",
    GROK_CODEX_SESSIONS_ENABLED: "false",
    GROK_SUBAGENTS: "0",
    GROK_MEMORY: "0",
    GROK_WEB_FETCH: "0",
    GROK_LSP_TOOLS: "0",
    GROK_WORKSPACE_TOOL_DEFS_ENABLED: "0",
    GROK_MANAGED_MCPS_ENABLED: "false",
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "false",
    GROK_MCP_AUTO_RESTART: "false",
    ...extra
  };
}

function safeMarker(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80); }

function outputSchemaDigest(outputSchema) {
  if (outputSchema == null) return null;
  if (!outputSchema
    || typeof outputSchema !== "object"
    || Array.isArray(outputSchema)) {
    throw new CompanionError("E_PROTOCOL", "Provider output schema must be a JSON object.");
  }
  let serialized;
  try {
    serialized = JSON.stringify(outputSchema);
  } catch {
    throw new CompanionError("E_PROTOCOL", "Provider output schema is not serializable JSON.");
  }
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
    throw new CompanionError("E_PROTOCOL", "Provider output schema exceeds 65536 bytes.");
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function authEntryExpiries(parsed) {
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
function ensureFreshCachedCredential(source, minimumValidityMs = 45 * 60 * 1000) {
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

    const refreshed = spawnSync(discoverGrok(), ["models"], {
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

function freshCachedCredentialPayload(
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

function isolatedCredentialPayload(source) {
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

function writeReviewCredential(source, destination, { refresh = false } = {}) {
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

function existingPrivateDirectoryIdentity(directory) {
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

function directoryIdentityMatches(identity) {
  try {
    const current = existingPrivateDirectoryIdentity(identity.path);
    return current.device === identity.device && current.inode === identity.inode;
  } catch {
    return false;
  }
}

function sameFileIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

function privateCredentialIdentity(stat) {
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

function openPrivateCredentialHandle(authFile) {
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

function neutralizeCredentialHandle(handle) {
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

function unlinkIdentityBoundCredential(authFile, directoryIdentities, identity) {
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

function stageRevocableTaskCredential(
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

export function reviewEnvironment(stateDir, jobMarker, { includeCredential = true } = {}) {
  const marker = safeMarker(jobMarker), home = path.join(stateDir, "review-homes", marker), grokHome = path.join(home, ".grok");
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  const sentinel = path.join(home, "sandbox-enforcement-sentinel"), profile = `companion_${crypto.createHash("sha256").update(marker).digest("hex").slice(0, 20)}`;
  if (!fs.existsSync(sentinel)) fs.writeFileSync(sentinel, "Review sandbox enforcement sentinel.\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(path.join(grokHome, "sandbox.toml"), `[profiles.${profile}]\nextends = "strict"\ndeny = [${JSON.stringify(sentinel)}]\n`, { mode: 0o600 });
  const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
  const extra = { HOME: home, USERPROFILE: home, GROK_HOME: grokHome, GROK_FOLDER_TRUST: "1" };
  const knownSecrets = [];
  if (includeCredential && fs.existsSync(authPath)) {
    ensureFreshCachedCredential(authPath);
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

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CompanionError("E_STATE", `Refusing unsafe isolated Grok directory ${directory}.`);
  fs.chmodSync(directory, 0o700);
}

function atomicPrivateFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function pathsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b
    || a.startsWith(`${b}${path.sep}`)
    || b.startsWith(`${a}${path.sep}`);
}

function executableFromPath(name, pathValue = process.env.PATH) {
  if (typeof name !== "string"
    || !/^[a-zA-Z0-9._-]+$/.test(name)
    || typeof pathValue !== "string") {
    throw new CompanionError(
      "E_CAPABILITY",
      "A trusted provider executable could not be resolved."
    );
  }
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const executableDirectory = fs.realpathSync(directory);
      const commandPath = path.join(executableDirectory, name);
      const executable = fs.realpathSync(commandPath);
      const stat = fs.lstatSync(executable);
      const parentStat = fs.lstatSync(executableDirectory);
      if (stat.isFile()
        && !stat.isSymbolicLink()
        && parentStat.isDirectory()
        && !parentStat.isSymbolicLink()) {
        return Object.freeze({
          commandPath,
          executable,
          executableDirectory
        });
      }
    } catch {
      // Continue to the next canonical PATH entry.
    }
  }
  throw new CompanionError(
    "E_CAPABILITY",
    `The ${name} executable is unavailable on the trusted host PATH.`
  );
}

function trustedGitInstallation(root, pathValue = process.env.PATH) {
  const located = executableFromPath("git", pathValue);
  const { commandPath, executable, executableDirectory } = located;
  const canonicalWorkspace = fs.realpathSync(root);
  if (pathsOverlap(executable, canonicalWorkspace)
    || pathsOverlap(executableDirectory, canonicalWorkspace)) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Refusing a repository-controlled Git executable for official provisioning."
    );
  }
  const installationCandidates = [
    "/opt/homebrew",
    "/usr/local"
  ];
  const installationRoot = installationCandidates.find((candidate) => (
    executable.startsWith(`${candidate}${path.sep}`)
  )) || path.dirname(executable);
  const canonicalInstallationRoot = fs.realpathSync(installationRoot);
  if (canonicalInstallationRoot === path.parse(canonicalInstallationRoot).root
    || pathsOverlap(canonicalInstallationRoot, canonicalWorkspace)) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The Git installation root is too broad or repository-controlled."
    );
  }
  const stat = fs.statSync(executable);
  const parentStat = fs.statSync(executableDirectory);
  return Object.freeze({
    commandPath,
    executable,
    executableDirectory,
    installationRoot: canonicalInstallationRoot,
    executableDigest: crypto
      .createHash("sha256")
      .update(fs.readFileSync(executable))
      .digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino
  });
}

function recaptureTrustedGitInstallation(identity) {
  const executableDirectory = fs.realpathSync(path.dirname(identity.commandPath));
  const executable = fs.realpathSync(identity.commandPath);
  const installationRoot = fs.realpathSync(identity.installationRoot);
  const stat = fs.statSync(executable);
  const parentStat = fs.statSync(executableDirectory);
  return Object.freeze({
    commandPath: path.join(executableDirectory, path.basename(identity.commandPath)),
    executable,
    executableDirectory,
    installationRoot,
    executableDigest: crypto
      .createHash("sha256")
      .update(fs.readFileSync(executable))
      .digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino
  });
}

function sameTrustedGitInstallation(left, right) {
  return Boolean(
    left
    && right
    && left.commandPath === right.commandPath
    && left.executable === right.executable
    && left.executableDirectory === right.executableDirectory
    && left.installationRoot === right.installationRoot
    && left.executableDigest === right.executableDigest
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.parentDevice === right.parentDevice
    && left.parentInode === right.parentInode
  );
}

function canonicalGitCommonDirectory(gitInstallation, workspaceRoot) {
  const gitEnvironment = controllerGitEnvironment(gitInstallation);
  const run = spawnSync(
    gitInstallation.executable,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
      env: gitEnvironment
    }
  );
  const value = String(run.stdout || "").trim();
  if (run.status !== 0
    || run.error
    || !value
    || !path.isAbsolute(value)
    || path.normalize(value) !== value) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The exact Git common directory could not be resolved for official provisioning."
    );
  }
  const resolved = fs.realpathSync(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The exact Git common directory is unsafe."
    );
  }
  return resolved;
}

function controllerGitEnvironment(gitInstallation) {
  const overrides = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", "/dev/null"],
    ["submodule.recurse", "false"]
  ];
  return childEnvironment({
    PATH: gitInstallation.executableDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(overrides.length),
    ...Object.fromEntries(overrides.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value]
    ]))
  });
}

function boundedGitRun(gitInstallation, workspaceRoot, args, {
  input = undefined,
  maxBuffer = 8 * 1024 * 1024
} = {}) {
  const run = spawnSync(gitInstallation.executable, args, {
    cwd: workspaceRoot,
    encoding: null,
    shell: false,
    timeout: 10_000,
    maxBuffer,
    env: controllerGitEnvironment(gitInstallation),
    ...(input === undefined ? {} : { input })
  });
  if (run.status !== 0 || run.error || run.signal) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The bounded Git checkout-safety inspection failed closed."
    );
  }
  return Buffer.isBuffer(run.stdout) ? run.stdout : Buffer.from(run.stdout || "");
}

function splitNulRecords(buffer, label) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) {
    throw new CompanionError("E_CAPABILITY", `${label} output was truncated.`);
  }
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const record = buffer.subarray(start, index);
    if (record.length === 0) {
      throw new CompanionError("E_CAPABILITY", `${label} output was malformed.`);
    }
    records.push(record);
    start = index + 1;
  }
  return records;
}

export function assertControllerGitCheckoutSafe({
  gitExecutable,
  gitExecutableDirectory,
  gitInstallationRoot,
  workspaceRoot,
  baseCommit
}) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit || "")) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Checkout-safety inspection requires one exact base commit."
    );
  }
  const gitInstallation = recaptureTrustedGitInstallation({
    commandPath: path.join(gitExecutableDirectory, "git"),
    executable: gitExecutable,
    executableDirectory: gitExecutableDirectory,
    installationRoot: gitInstallationRoot
  });
  if (gitInstallation.executable !== gitExecutable) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The trusted Git executable changed before checkout-safety inspection."
    );
  }
  const tracked = splitNulRecords(
    boundedGitRun(
      gitInstallation,
      workspaceRoot,
      ["ls-tree", "-r", "-z", "--name-only", baseCommit]
    ),
    "git ls-tree"
  );
  if (tracked.length > 100_000) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The checkout-safety file inventory exceeded its bound."
    );
  }
  if (tracked.length === 0) return Object.freeze({ trackedFiles: 0 });
  const input = Buffer.concat(
    tracked.flatMap((record) => [record, Buffer.from([0])])
  );
  const attributes = splitNulRecords(
    boundedGitRun(
      gitInstallation,
      workspaceRoot,
      [
        "check-attr",
        `--source=${baseCommit}`,
        "-z",
        "--stdin",
        "filter"
      ],
      { input }
    ),
    "git check-attr"
  );
  if (attributes.length !== tracked.length * 3) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Git filter attribute inspection returned an inexact record count."
    );
  }
  for (let index = 0; index < tracked.length; index += 1) {
    const [file, attribute, value] = attributes.slice(index * 3, index * 3 + 3);
    if (!file.equals(tracked[index])
      || attribute.toString("utf8") !== "filter"
      || !["unspecified", "unset"].includes(value.toString("utf8"))) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Repository checkout attributes could execute an external Git filter."
      );
    }
  }
  return Object.freeze({ trackedFiles: tracked.length });
}

function captureGitInfoAttributesBinding(gitCommonDir) {
  const attributesPath = path.join(gitCommonDir, "info", "attributes");
  try {
    const stat = fs.lstatSync(attributesPath);
    if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.size > 1024 * 1024) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Git info attributes must be absent or one bounded regular file."
      );
    }
    return Object.freeze({
      path: attributesPath,
      state: "present",
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      digest: crypto
        .createHash("sha256")
        .update(fs.readFileSync(attributesPath))
        .digest("hex")
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return Object.freeze({
      path: attributesPath,
      state: "absent"
    });
  }
}

function assertNoGitObjectAlternates(gitCommonDir) {
  if (typeof process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES === "string"
    && process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.length > 0) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Git alternate object directories are not authorized for official provisioning."
    );
  }
  const alternatesPath = path.join(
    gitCommonDir,
    "objects",
    "info",
    "alternates"
  );
  try {
    const stat = fs.lstatSync(alternatesPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 0) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Git object alternates are not authorized for official provisioning."
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sameGitInfoAttributesBinding(left, right) {
  return Boolean(
    left
    && right
    && left.path === right.path
    && left.state === right.state
    && (left.state === "absent"
      || (
        left.device === right.device
        && left.inode === right.inode
        && left.size === right.size
        && left.digest === right.digest
      ))
  );
}

function ensureGitWorktreesMetadataRoot(gitCommonDir) {
  const metadataRoot = path.join(gitCommonDir, "worktrees");
  try {
    fs.mkdirSync(metadataRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const resolved = fs.realpathSync(metadataRoot);
  const stat = fs.lstatSync(resolved);
  if (resolved !== metadataRoot
    || !stat.isDirectory()
    || stat.isSymbolicLink()) {
    throw new CompanionError(
      "E_CAPABILITY",
      "The exact Git worktree metadata directory is unsafe."
    );
  }
  return resolved;
}

function canonicalProvisioningDestination({
  parent,
  expectedRoot,
  stateDir
}) {
  if (typeof parent !== "string"
    || typeof expectedRoot !== "string"
    || !path.isAbsolute(parent)
    || !path.isAbsolute(expectedRoot)
    || path.normalize(parent) !== parent
    || path.normalize(expectedRoot) !== expectedRoot) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Official provisioning requires one exact private destination parent and child."
    );
  }
  const canonicalStateDir = fs.realpathSync(stateDir);
  const canonicalParent = fs.realpathSync(parent);
  const parentStat = fs.lstatSync(canonicalParent);
  const resolvedRoot = path.resolve(expectedRoot);
  const relativeParent = path.relative(canonicalStateDir, canonicalParent);
  if (canonicalParent !== parent
    || !relativeParent
    || relativeParent.startsWith("..")
    || path.isAbsolute(relativeParent)
    || canonicalParent === path.resolve(stateDir, "worktrees")
    || path.dirname(resolvedRoot) !== canonicalParent
    || resolvedRoot === canonicalParent
    || !parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o077) !== 0
    || fs.readdirSync(canonicalParent).length !== 0) {
    throw new CompanionError(
      "E_CAPABILITY",
      "Official provisioning destination parent is shared, aliased, nonempty, or not private."
    );
  }
  try {
    fs.lstatSync(resolvedRoot);
    throw new CompanionError(
      "E_CAPABILITY",
      "Official provisioning destination child must not exist before create."
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({
    parent: canonicalParent,
    expectedRoot: resolvedRoot
  });
}

function canonicalExistingRoot(value) {
  try { return fs.realpathSync(value); }
  catch { return path.resolve(value); }
}

function broadTemporaryRoots() {
  return [...new Set([
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP
  ]
    .filter((value) => typeof value === "string" && path.isAbsolute(value))
    .map(canonicalExistingRoot))];
}

function assertControllerAuthorityOutsideBroadTemp({
  controlRoot,
  gitCommonDir,
  stateDir,
  destinationParent
}) {
  const temporaryRoots = broadTemporaryRoots();
  for (const [label, authorityRoot] of [
    ["control source", controlRoot],
    ["Git common directory", gitCommonDir],
    ["shared controller state", stateDir],
    ["destination parent", destinationParent]
  ]) {
    const canonical = canonicalExistingRoot(authorityRoot);
    if (temporaryRoots.some((temporaryRoot) => (
      canonical === temporaryRoot
      || canonical.startsWith(`${temporaryRoot}${path.sep}`)
    ))) {
      throw new CompanionError(
        "E_CAPABILITY",
        `The ${label} overlaps a broad strict-sandbox temporary write grant.`
      );
    }
  }
}

function assertControllerGitSeparation({
  gitInstallation,
  controlRoot,
  stateDir,
  home,
  destinationRoot
}) {
  const temporaryRoots = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP
  ].filter((value) => typeof value === "string" && path.isAbsolute(value));
  const forbidden = [
    controlRoot,
    stateDir,
    home,
    destinationRoot,
    ...temporaryRoots
  ].map(canonicalExistingRoot);
  for (const trustedPath of [
    gitInstallation.executable,
    gitInstallation.executableDirectory,
    gitInstallation.installationRoot
  ]) {
    if (forbidden.some((candidate) => pathsOverlap(trustedPath, candidate))) {
      throw new CompanionError(
        "E_CAPABILITY",
        "The trusted Git installation overlaps controller-owned or temporary state."
      );
    }
  }
}

export function taskEnvironment(
  stateDir,
  root,
  profile,
  homeMarker = "task",
  {
    worktreeProvisioningController = false,
    worktreeProvisioningDestinationParent = null,
    worktreeProvisioningExpectedRoot = null,
    worktreeProvisioningGitCommonDir = null,
    worktreeProvisioningBaseCommit = null
  } = {}
) {
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
    const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
    if (!fs.existsSync(authPath)) throw new CompanionError("E_AUTH_REQUIRED", `Grok cached authentication is unavailable. Run \`grok login\`, then ${hostCommand("setup")}.`);
    if (!worktreeProvisioningController) {
      ensureFreshCachedCredential(authPath);
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

/**
 * Stage only a short-lived credential in an existing isolated task home.
 * Qualification cleanup uses this after the provider runtime has already
 * removed its execution credential; it must not rewrite task configuration or
 * sandbox policy while proving provider-session deletion.
 */
export function taskCredentialEnvironment(stateDir, homeMarker = "task") {
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
  ensureFreshCachedCredential(authPath);
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

function protectedGitPaths(root) {
  const run = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: root, encoding: "utf8", shell: false, timeout: 10000 });
  const values = run.status === 0 ? String(run.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
  const dotGit = path.join(fs.realpathSync(root), ".git");
  return [...new Set([dotGit, ...values.map((item) => path.resolve(root, item))])];
}

export function inspectIsolation(binary, root, environment) {
  const inspect = spawnSync(binary, ["inspect", "--json"], { cwd: root, encoding: "utf8", shell: false, timeout: 30000, env: environment.env });
  if (inspect.status !== 0 || inspect.error) throw new CompanionError("E_CAPABILITY", "Grok could not validate the isolated provider environment.", { diagnostic: redactText(inspect.error?.message || inspect.stderr || inspect.stdout, environment.knownSecrets).slice(-2000) });
  let value;
  try { value = JSON.parse(inspect.stdout); }
  catch { throw new CompanionError("E_CAPABILITY", "Grok inspect returned malformed JSON for the isolated provider environment."); }
  const nonBuiltinAgents = (value.agents || []).filter((agent) => agent?.source?.type !== "builtin");
  const bundledSkillRoots = [
    path.join(environment.grokHome, "skills"),
    path.join(environment.grokHome, "bundled", "skills")
  ];
  const externalSkills = (value.skills || []).filter((skill) => {
    if (skill?.source?.type === "builtin") return false;
    if (skill?.source?.type !== "bundled" || typeof skill.source.path !== "string") return true;
    try {
      const actual = fs.realpathSync(skill.source.path);
      return !bundledSkillRoots.some((candidate) => {
        try {
          const rootPath = fs.realpathSync(candidate);
          return actual === rootPath || actual.startsWith(`${rootPath}${path.sep}`);
        } catch { return false; }
      });
    } catch { return true; }
  });
  if ((value.hooks || []).length || externalSkills.length || (value.plugins || []).length || (value.mcpServers || []).length || nonBuiltinAgents.length) {
    throw new CompanionError("E_CAPABILITY", "The isolated provider environment loaded external hooks, skills, plugins, MCP servers, or agents.");
  }
  return value;
}

function checkedInAgentProfile(profile) {
  if (profile?.id === "rescue-read-v3") return path.join(PLUGIN_ROOT, "provider-agents", "rescue-read.md");
  if (profile?.id === "rescue-write-v3") return path.join(PLUGIN_ROOT, "provider-agents", "rescue-write.md");
  if (profile?.id === "rescue-report-v3") return path.join(PLUGIN_ROOT, "provider-agents", "report-repair.md");
  if (profile?.id === "setup-probe-v2") return path.join(PLUGIN_ROOT, "provider-agents", "setup-probe.md");
  return null;
}

/**
 * Verify the packaged profile, then materialize it inside the isolated Grok
 * home. Grok's own filesystem boundary may reject Codex's plugin cache even
 * though the host process can read it, so provider argv must not point back to
 * the installation tree.
 */
function materializeAgentProfile(profile, environment) {
  const source = checkedInAgentProfile(profile);
  if (!source) return { path: null, cleanup() {} };
  const contents = fs.readFileSync(source);
  const expectedDigest = profile.agentProfileDigest;
  const actualDigest = crypto.createHash("sha256").update(contents).digest("hex");
  if (!expectedDigest || expectedDigest !== actualDigest) {
    const label = profile.id === "setup-probe-v2" ? "setup probe" : "rescue task";
    throw new CompanionError("E_SECURITY_PROFILE", `The checked-in Grok agent profile changed; start a fresh ${label} under the current security contract.`);
  }
  if (!environment?.grokHome) {
    throw new CompanionError("E_SECURITY_PROFILE", "A checked-in Grok agent profile requires an isolated GROK_HOME; refusing to expose a source or plugin-cache path to the provider.");
  }

  privateDirectory(environment.grokHome);
  const directory = path.join(environment.grokHome, "agent-profiles");
  privateDirectory(directory);
  const destination = path.join(directory, `${safeMarker(profile.id)}-${expectedDigest}-${crypto.randomBytes(8).toString("hex")}.md`);
  try {
    atomicPrivateFile(destination, contents);
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new CompanionError("E_SECURITY_PROFILE", "The isolated Grok agent profile is not a private regular file.");
    }
    const materializedDigest = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
    if (materializedDigest !== expectedDigest) {
      throw new CompanionError("E_SECURITY_PROFILE", "The isolated Grok agent profile does not match the checked-in security contract.");
    }
  } catch (error) {
    try { fs.unlinkSync(destination); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    throw error;
  }
  let cleaned = false;
  return {
    path: destination,
    cleanup() {
      if (cleaned) return;
      try { fs.unlinkSync(destination); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      try { fs.rmdirSync(directory); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
      cleaned = true;
    }
  };
}

// Startup can fail after the provider process and its isolated home exist but
// before openProvider can return a provider handle. Keep the verified process
// identity on cleanup failures without exposing it through serialized error
// details, so callers can retain credentials/state while that group may live.
const PROVIDER_CLEANUP_IDENTITY = Symbol("grok-provider-cleanup-identity");

function attachProviderCleanupIdentity(error, identity) {
  if (error && typeof error === "object" && identity) {
    Object.defineProperty(error, PROVIDER_CLEANUP_IDENTITY, {
      configurable: true,
      enumerable: false,
      value: identity
    });
  }
  return error;
}

export function providerCleanupIdentity(error) {
  return error && typeof error === "object" ? error[PROVIDER_CLEANUP_IDENTITY] || null : null;
}

/** Acquire a birth token before exposing a freshly spawned detached group. */
export async function captureSpawnIdentity(child, {
  timeoutMs = 750,
  intervalMs = 25,
  shutdownTimeoutMs = 750,
  readStartToken = processStartToken,
  isGroupAlive = processGroupAlive,
  signalGroup = (pid, signal) => process.kill(-pid, signal)
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new CompanionError("E_PROCESS_IDENTITY", "Grok did not expose a valid provider PID after spawn.");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const startToken = readStartToken(pid);
    if (startToken) return { pid, startToken, processGroupId: process.platform === "win32" ? null : pid };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  } while (true);

  const identity = { pid, startToken: null, processGroupId: process.platform === "win32" ? null : pid };
  const waitGone = async () => {
    const stop = Date.now() + Math.max(0, shutdownTimeoutMs);
    while (isGroupAlive(pid) && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalMs)));
    return !isGroupAlive(pid);
  };
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try { signalGroup(pid, signal); }
    catch (error) { if (error.code !== "ESRCH") break; }
    if (await waitGone()) break;
  }
  const error = new CompanionError("E_PROCESS_IDENTITY", "Could not record the Grok provider birth token before startup; the process was stopped before task execution.", { pid });
  if (isGroupAlive(pid)) throw attachProviderCleanupIdentity(error, identity);
  throw error;
}

async function cleanupFailedProviderStart({ child, identity, root, marker, stagedProfile, client = null, guardRecord = null }) {
  let cleanupError = null;
  try { client?.close(); }
  catch (error) { cleanupError = error; }

  try {
    await ensureChildExit(child, identity);
  } catch (error) {
    // Do not unregister the guard or remove the staged profile while the owned
    // process group may still be using either one.
    throw attachProviderCleanupIdentity(error, identity);
  }

  if (guardRecord) {
    try { unregisterProviderGuard(root, marker, guardRecord); }
    catch (error) { throw attachProviderCleanupIdentity(error, identity); }
  }
  try { stagedProfile.cleanup(); }
  catch (error) { cleanupError ||= error; }
  if (cleanupError) throw attachProviderCleanupIdentity(cleanupError, identity);
}

function spawnArgs({ root, profile, model, effort, leaderSocket, taskProfile = null }) {
  const readOnlyProfile = profile.id === "rescue-read-v3" || profile.id === "rescue-report-v3" || profile.id === "setup-probe-v2";
  const args = ["--cwd", root, "--sandbox", profile.sandbox, "--permission-mode", profile.permissionMode, "--deny", "WebFetch", "--deny", "MCPTool", "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan"];
  if (profile.id === WORKTREE_CONTROLLER_PROFILE_ID
    || profile.id === WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID
    || profile.id === WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID) {
    args.push(
      "--deny", "Bash",
      "--deny", "Edit",
      "--deny", "Write",
      "--deny", "Read",
      "--deny", "Grep",
      "--deny", "WebSearch"
    );
  } else if (readOnlyProfile) args.push("--deny", "Bash", "--deny", "Edit", "--deny", "Write");
  else if (profile.id === "rescue-write-v3") args.push("--deny", "Bash");
  // Setup probe uses permissionMode dontAsk, so it never receives unattended --always-approve expansion.
  if (profile.permissionMode === "bypassPermissions") args.push("--always-approve");
  args.push("agent", "--no-leader", "--leader-socket", leaderSocket);
  if (taskProfile) args.push("--agent-profile", taskProfile);
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  args.push("stdio");
  return args;
}

export function workerOwnerControllerSpawnArgs({
  environment,
  leaderSocket
} = {}) {
  if (!environment
    || ![
      WORKTREE_INTEGRATION_CONTROLLER_PROFILE_ID,
      WORKTREE_CLEANUP_CONTROLLER_PROFILE_ID
    ].includes(environment.profileId)
    || typeof environment.controllerCwd !== "string"
    || !path.isAbsolute(environment.controllerCwd)
    || typeof environment.sandboxProfile !== "string"
    || !environment.sandboxProfile
    || typeof leaderSocket !== "string"
    || !path.isAbsolute(leaderSocket)) {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Worker owner-controller runtime profile is malformed."
    );
  }
  return Object.freeze(spawnArgs({
    root: environment.controllerCwd,
    profile: {
      id: environment.profileId,
      sandbox: environment.sandboxProfile,
      permissionMode: "dontAsk"
    },
    model: null,
    effort: null,
    leaderSocket,
    taskProfile: null
  }));
}

function extractJson(text) {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  return null;
}

/**
 * Wait for an ACP startup request while polling the durable job cancellation
 * source. Startup does not have a session ID yet, so there is no meaningful
 * session/cancel notification to send. Rejecting here hands control directly
 * to the caller's verified process-group teardown path.
 *
 * Attach handlers to the ACP request for its full lifetime even when
 * cancellation wins. That prevents the later transport-close rejection from
 * becoming unhandled, while the single-settlement guard keeps request and
 * cancellation completion from racing caller cleanup twice.
 */
function requestDuringProviderStartup(client, method, params, timeoutMs, cancelRequested, { pollMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let poll = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (poll) clearTimeout(poll);
      callback(value);
    };
    const cancellationError = () => new CompanionError(
      "E_CANCELLED",
      `Grok job was cancelled during ACP ${method} startup.`
    );
    const checkCancellation = () => {
      if (settled) return;
      let cancelled;
      try { cancelled = cancelRequested(); }
      catch (error) { finish(reject, error); return; }
      if (cancelled) { finish(reject, cancellationError()); return; }
      poll = setTimeout(checkCancellation, pollMs);
    };

    try {
      if (cancelRequested()) {
        finish(reject, cancellationError());
        return;
      }
    } catch (error) {
      finish(reject, error);
      return;
    }

    let request;
    try { request = client.request(method, params, timeoutMs); }
    catch (error) { finish(reject, error); return; }
    request.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
    poll = setTimeout(checkCancellation, pollMs);
  });
}

/**
 * Validate provider review payload and deterministically derive the verdict.
 * Zero findings always passes; nonzero findings always needs_changes.
 * Model-supplied verdict is rejected; the public verdict exists only after validation.
 */
export function validateReview(value) {
  const rootKeys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const allowedKeys = new Set(["summary", "findings"]);
  const reviewPathOk = (file) => {
    if (file === undefined || file === null) return true;
    if (typeof file !== "string" || !file.trim() || file.length > 1024) return false;
    const normalized = file.replace(/\\/g, "/");
    return !path.posix.isAbsolute(normalized)
      && !/^[A-Za-z]:\//.test(normalized)
      && !normalized.split("/").includes("..");
  };
  const findingsOk = Array.isArray(value?.findings) && value.findings.length <= 200 && value.findings.every((f) => f
    && typeof f === "object"
    && !Array.isArray(f)
    && Object.keys(f).every((key) => ["severity", "title", "body", "file", "line"].includes(key))
    && ["critical", "high", "medium", "low", "info"].includes(f.severity)
    && typeof f.title === "string" && f.title.trim() && f.title.length <= 240
    && typeof f.body === "string" && f.body.trim() && f.body.length <= 6000
    && reviewPathOk(f.file)
    && (f.line === undefined || f.line === null || (Number.isInteger(f.line) && f.line >= 1)));
  const ok = Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && rootKeys.every((key) => allowedKeys.has(key))
    && typeof value.summary === "string"
    && value.summary.trim()
    && value.summary.length <= 2000
    && findingsOk
  );
  if (!ok) {
    const details = {
      rootKeys: rootKeys.filter((key) => allowedKeys.has(key)).slice(0, 24),
      hasUnknownRootKeys: rootKeys.some((key) => !allowedKeys.has(key)),
      summaryType: typeof value?.summary,
      findingsCount: Array.isArray(value?.findings) ? value.findings.length : null,
      findingsShapeOk: findingsOk,
      hint: "Return only summary and findings. Omit verdict; the runtime derives it. Paths must be repository-relative and strings must stay within schema limits."
    };
    try {
      details.payloadDigest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    } catch {
      details.payloadDigest = null;
    }
    throw new CompanionError("E_SCHEMA", "Grok review output did not match the required schema.", details);
  }
  const findings = value.findings.map((f) => ({
    severity: f.severity,
    title: redactText(f.title.trim()),
    body: redactText(f.body.trim()),
    ...(f.file === undefined ? {} : { file: f.file === null ? null : redactText(f.file.trim().replace(/\\/g, "/")) }),
    ...(f.line === undefined ? {} : { line: f.line })
  }));
  return {
    verdict: findings.length === 0 ? "pass" : "needs_changes",
    summary: redactText(value.summary.trim()),
    findings
  };
}

/**
 * Select an ACP session/request_permission option using exact protocol semantics.
 * Write profiles may only accept allow-once; read-only profiles only reject/deny.
 * Labels/names are never trusted. allow-always / allow-session are never selected.
 * Conflicting kind/optionId pairs (e.g. kind allow_once with optionId allow-always)
 * are rejected on both exact and legacy branches.
 */
export function selectAcpPermissionOption(options, { write = false } = {}) {
  const list = Array.isArray(options) ? options.filter((option) => option && typeof option === "object") : [];
  const kindOf = (option) => String(option.kind || "");
  const idOf = (option) => String(option.optionId || "");
  const isAllowAlwaysOrSession = (option) => {
    const kind = kindOf(option);
    const id = idOf(option);
    return kind === "allow_always" || kind === "allow-always" || kind === "allow_session" || kind === "allow-session"
      || id === "allow_always" || id === "allow-always" || id === "allow_session" || id === "allow-session";
  };
  const isAnyAllow = (option) => {
    if (isAllowAlwaysOrSession(option)) return true;
    const kind = kindOf(option);
    const id = idOf(option);
    return kind === "allow_once" || kind === "allow-once"
      || id === "allow-once" || id === "allow_once";
  };
  const isAllowOnce = (option) => {
    // Non-empty optionId required (protocol answers with optionId; UUID ids + kind allow_once ok).
    // Reject when either field signals allow-always/session; accept allow-once hyphen/underscore forms.
    if (!idOf(option) || isAllowAlwaysOrSession(option)) return false;
    const kind = kindOf(option);
    const id = idOf(option);
    return kind === "allow_once" || kind === "allow-once"
      || id === "allow-once" || id === "allow_once";
  };
  const isRejectOrDeny = (option) => {
    if (!idOf(option) || isAnyAllow(option)) return false;
    const kind = kindOf(option);
    const id = idOf(option);
    // Exact reject/deny forms.
    if (kind === "reject_once" || kind === "reject_always" || kind === "deny"
      || id === "reject-once" || id === "reject-always" || id === "deny") return true;
    // Legacy hyphen/underscore variants.
    return kind === "reject-once" || kind === "reject-always" || kind === "deny_once" || kind === "deny-once"
      || id === "reject_once" || id === "reject_always" || id === "deny_once" || id === "deny-once";
  };

  if (write) {
    // Write may select only a nonpersistent allow-once option; reject any allow-always/session
    // signal in either kind or optionId on both exact and legacy matches.
    return list.find((option) => isAllowOnce(option)) || null;
  }

  // Read-only: never return an allow option even when kind says reject/deny.
  return list.find((option) => isRejectOrDeny(option)) || null;
}

export function createProviderBootstrapLaunch({
  root,
  marker,
  owner,
  binding,
  binary,
  executableIdentity = null,
  args
}) {
  const worktreeProvisioning = isWorktreeProvisioningBinding(binding);
  const workerOwnerController = isWorkerOwnerControllerBinding(binding);
  const isolatedController = worktreeProvisioning || workerOwnerController;
  const validOwnerController = workerOwnerController && (() => {
    try {
      assertWorkerOwnerControllerBinding(binding);
      return root !== binding.controlRoot && root !== binding.executionRoot;
    } catch {
      return false;
    }
  })();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(marker || "")
    || typeof owner !== "string"
    || !owner
    || (worktreeProvisioning
      ? !validWorktreeProvisioningBinding(binding, root)
      : workerOwnerController
        ? !validOwnerController
      : (
        !Number.isSafeInteger(binding?.providerGeneration)
        || binding.providerGeneration < 1
        || !EXACT_NONCE_ID.test(binding?.providerSpawnIntentId || "")
      ))
    || (isolatedController && (() => {
      try {
        assertExecutableAttestation(executableIdentity);
        return false;
      } catch {
        return true;
      }
    })())) {
    throw new CompanionError("E_STATE", "Provider bootstrap launch binding is malformed.");
  }
  const specPayload = `${JSON.stringify({
    schemaVersion: 1,
    root,
    marker,
    owner,
    binding,
    binary,
    ...(isolatedController ? { executableIdentity } : {}),
    args
  })}\n`;
  if (Buffer.byteLength(specPayload, "utf8") > MAX_PROVIDER_BOOTSTRAP_SPEC_BYTES) {
    throw new CompanionError("E_USAGE", "Provider bootstrap specification exceeds its private channel limit.");
  }
  return Object.freeze({
    argv: Object.freeze(worktreeProvisioning
      ? [
          PROVIDER_BOOTSTRAP,
          "--job-marker", marker,
          "--bootstrap-purpose", binding.purpose,
          "--provisioning-attempt-id", binding.provisioningAttemptId,
          "--provisioning-fence", String(binding.provisioningFence),
          "--holder-id", binding.holderId,
          "--spawn-intent-id", binding.providerSpawnIntentId
        ]
      : workerOwnerController
        ? [
            PROVIDER_BOOTSTRAP,
            "--job-marker", marker,
            "--bootstrap-purpose", binding.purpose,
            "--controller-attempt-id", binding.controllerAttemptId,
            "--controller-fence", String(binding.controllerFence),
            "--holder-id", binding.holderId,
            "--spawn-intent-id", binding.providerSpawnIntentId
          ]
      : [
          PROVIDER_BOOTSTRAP,
          "--job-marker", marker,
          "--provider-generation", String(binding.providerGeneration),
          "--spawn-intent-id", binding.providerSpawnIntentId
        ]),
    specPayload
  });
}

export function publishProviderBootstrapSpec(child, specPayload, { timeoutMs = 5_000 } = {}) {
  const channel = child?.stdio?.[PROVIDER_BOOTSTRAP_SPEC_FD];
  if (!channel || typeof channel.end !== "function") {
    return Promise.reject(new CompanionError("E_PROTOCOL", "Provider bootstrap specification pipe is unavailable."));
  }
  if (channel.destroyed || channel.closed || channel.writableEnded) {
    return Promise.reject(new CompanionError("E_PROVIDER_EXIT", "Provider bootstrap specification pipe is already closed."));
  }
  if (typeof specPayload !== "string"
    || !specPayload.endsWith("\n")
    || Buffer.byteLength(specPayload, "utf8") > MAX_PROVIDER_BOOTSTRAP_SPEC_BYTES
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30_000) {
    return Promise.reject(new CompanionError("E_USAGE", "Provider bootstrap specification publication is invalid."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const absorbLateError = () => {};
    channel.on("error", absorbLateError);
    channel.once("close", () => channel.off("error", absorbLateError));
    const timeout = setTimeout(() => fail(new CompanionError(
      "E_PROVIDER_TIMEOUT",
      "Provider bootstrap did not consume its private specification."
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      channel.off("error", onChannelError);
      channel.off("close", onChannelClose);
      child.off("error", onChildError);
      child.off("exit", onChildExit);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => {
      try { channel.destroy(); } catch {}
      finish(reject, error);
    };
    const onChannelError = () => fail(new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap specification pipe failed."
    ));
    const onChannelClose = () => {
      if (!channel.writableFinished) {
        fail(new CompanionError("E_PROVIDER_EXIT", "Provider bootstrap specification pipe closed before publication."));
        return;
      }
      finish(resolve);
    };
    const onChildError = (error) => fail(error);
    const onChildExit = (code, signal) => fail(new CompanionError(
      "E_PROVIDER_EXIT",
      `Provider bootstrap exited before consuming its specification (${code ?? signal}).`
    ));
    channel.on("error", onChannelError);
    channel.once("close", onChannelClose);
    child.once("error", onChildError);
    child.once("exit", onChildExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onChildExit(child.exitCode, child.signalCode);
      return;
    }
    try { channel.end(specPayload); }
    catch { onChannelError(); }
  });
}

export function assertProviderBootstrapReadyMessage(
  message,
  binding,
  expectedExecutableIdentity = null
) {
  const worktreeProvisioning = isWorktreeProvisioningBinding(binding);
  const workerOwnerController = isWorkerOwnerControllerBinding(binding);
  const writeExecution = !worktreeProvisioning
    && !workerOwnerController
    && Object.hasOwn(binding || {}, "executionBindingDigest");
  const keys = new Set([
    "type",
    "grokPid",
    "version",
    ...(worktreeProvisioning
      ? [
          "purpose",
          "executionBindingDigest",
          "provisioningAttemptId",
          "provisioningFence",
          "holderId",
          "providerSpawnIntentId",
          "executableIdentity"
        ]
      : workerOwnerController
        ? [
            "purpose",
            "executionBindingDigest",
            "effectBindingDigest",
            "controllerAttemptId",
            "controllerFence",
            "holderId",
            "providerSpawnIntentId",
            "executableIdentity"
          ]
      : (writeExecution ? ["executionBindingDigest"] : []))
  ]);
  const valid = exactRecord(message, keys)
    && message.type === "provider-ready"
    && Number.isInteger(message.grokPid)
    && message.grokPid > 0
    && /^\d+\.\d+\.\d+$/.test(message.version || "")
    && (worktreeProvisioning
      ? (
        validWorktreeProvisioningBinding(binding)
        && message.purpose === binding.purpose
        && message.executionBindingDigest === binding.executionBindingDigest
        && message.provisioningAttemptId === binding.provisioningAttemptId
        && message.provisioningFence === binding.provisioningFence
        && message.holderId === binding.holderId
        && message.providerSpawnIntentId === binding.providerSpawnIntentId
        && sameExecutableAttestation(
          message.executableIdentity,
          expectedExecutableIdentity
        )
      )
      : workerOwnerController
        ? (() => {
            try {
              assertWorkerOwnerControllerBinding(binding);
            } catch {
              return false;
            }
            return message.purpose === binding.purpose
              && message.executionBindingDigest === binding.executionBindingDigest
              && message.effectBindingDigest === binding.effectBindingDigest
              && message.controllerAttemptId === binding.controllerAttemptId
              && message.controllerFence === binding.controllerFence
              && message.holderId === binding.holderId
              && message.providerSpawnIntentId === binding.providerSpawnIntentId
              && sameExecutableAttestation(
                message.executableIdentity,
                expectedExecutableIdentity
              );
          })()
      : (
        !writeExecution
        || (
          SHA256_HEX.test(binding.executionBindingDigest || "")
          && message.executionBindingDigest === binding.executionBindingDigest
        )
      ));
  if (!valid) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Provider bootstrap readiness was not exactly bound."
    );
  }
  return message;
}

export function assertProviderBootstrapPromotionMessage(message, binding) {
  const worktreeProvisioning = isWorktreeProvisioningBinding(binding);
  const workerOwnerController = isWorkerOwnerControllerBinding(binding);
  const writeExecution = !worktreeProvisioning
    && !workerOwnerController
    && Object.hasOwn(binding || {}, "executionBindingDigest");
  const keys = new Set([
    "type",
    "marker",
    ...(worktreeProvisioning
      ? [
          "purpose",
          "executionBindingDigest",
          "provisioningAttemptId",
          "provisioningFence",
          "holderId",
          "providerSpawnIntentId"
        ]
      : workerOwnerController
        ? [
            "purpose",
            "executionBindingDigest",
            "effectBindingDigest",
            "controllerAttemptId",
            "controllerFence",
            "holderId",
            "providerSpawnIntentId"
          ]
      : [
          "providerGeneration",
          "providerSpawnIntentId",
          ...(writeExecution ? ["executionBindingDigest"] : [])
        ])
  ]);
  const valid = exactRecord(message, keys)
    && message.type === "provider-promoted"
    && message.marker === binding?.marker
    && (worktreeProvisioning
      ? (
        validWorktreeProvisioningBinding(
          Object.fromEntries(
            Object.entries(binding).filter(([key]) => key !== "marker")
          )
        )
        && message.purpose === binding.purpose
        && message.executionBindingDigest === binding.executionBindingDigest
        && message.provisioningAttemptId === binding.provisioningAttemptId
        && message.provisioningFence === binding.provisioningFence
        && message.holderId === binding.holderId
        && message.providerSpawnIntentId === binding.providerSpawnIntentId
      )
      : workerOwnerController
        ? (() => {
            const withoutMarker = Object.fromEntries(
              Object.entries(binding || {}).filter(([key]) => key !== "marker")
            );
            try {
              assertWorkerOwnerControllerBinding(withoutMarker);
            } catch {
              return false;
            }
            return message.purpose === binding.purpose
              && message.executionBindingDigest === binding.executionBindingDigest
              && message.effectBindingDigest === binding.effectBindingDigest
              && message.controllerAttemptId === binding.controllerAttemptId
              && message.controllerFence === binding.controllerFence
              && message.holderId === binding.holderId
              && message.providerSpawnIntentId === binding.providerSpawnIntentId;
          })()
      : (
        message.providerGeneration === binding?.providerGeneration
        && message.providerSpawnIntentId === binding?.providerSpawnIntentId
        && (!writeExecution || (
          SHA256_HEX.test(binding.executionBindingDigest || "")
          && message.executionBindingDigest === binding.executionBindingDigest
        ))
      ));
  if (!valid) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Provider bootstrap promotion acknowledgement was not exactly bound."
    );
  }
  return message;
}

export function waitForProviderBootstrapReady(
  child,
  cancelRequested,
  binding,
  expectedExecutableIdentity,
  {
  timeoutMs = 10_000,
  pollMs = 50
  } = {}
) {
  const readiness = child?.stdio?.[3];
  if (!readiness) {
    return Promise.reject(new CompanionError("E_PROTOCOL", "Provider bootstrap readiness channel is unavailable."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let poll = null;
    const timeout = setTimeout(() => finish(reject, new CompanionError(
      "E_PROVIDER_TIMEOUT",
      "Provider bootstrap did not publish readiness before timeout."
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (poll) clearTimeout(poll);
      readiness.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      `Provider bootstrap exited before readiness (${code ?? signal}).`
    ));
    const onData = (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024) {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap readiness exceeded its limit."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim()) {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap readiness contained extra data."));
        return;
      }
      let message;
      try { message = JSON.parse(buffer.slice(0, newline)); }
      catch {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap readiness was malformed."));
        return;
      }
      if (message?.type === "provider-ready" && Number.isInteger(message.grokPid)) {
        try {
          finish(resolve, assertProviderBootstrapReadyMessage(
            message,
            binding,
            expectedExecutableIdentity
          ));
        }
        catch (error) { finish(reject, error); }
        return;
      }
      finish(reject, new CompanionError(
        message?.code || "E_PROVIDER_EXIT",
        message?.message || "Provider bootstrap rejected provider startup."
      ));
    };
    const checkCancellation = () => {
      if (settled) return;
      try {
        if (cancelRequested()) {
          finish(reject, new CompanionError("E_CANCELLED", "Grok job was cancelled during provider bootstrap."));
          return;
        }
      } catch (error) {
        finish(reject, error);
        return;
      }
      poll = setTimeout(checkCancellation, pollMs);
    };
    readiness.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    poll = setTimeout(checkCancellation, pollMs);
  });
}

export function promoteProviderBootstrap(child, binding, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const control = child?.stdio?.[4];
    const acknowledgement = child?.stdio?.[5];
    if (!control || !acknowledgement) {
      reject(new CompanionError("E_PROCESS_IDENTITY", "Provider bootstrap promotion pipes are unavailable."));
      return;
    }
    let settled = false;
    let buffer = "";
    // Retain passive error listeners for each pipe's remaining lifetime. The
    // exact handshake listener below still fails closed while admission is in
    // flight, and a late EPIPE can never become an uncaught process error.
    const absorbControlError = () => {};
    const absorbAcknowledgementError = () => {};
    control.on("error", absorbControlError);
    acknowledgement.on("error", absorbAcknowledgementError);
    control.once("close", () => control.off("error", absorbControlError));
    acknowledgement.once("close", () => acknowledgement.off("error", absorbAcknowledgementError));
    const timeout = setTimeout(() => finish(reject, new CompanionError(
      "E_PROVIDER_TIMEOUT",
      "Provider bootstrap did not acknowledge durable dispatch promotion."
    )), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      control.off("error", onControlError);
      acknowledgement.off("data", onData);
      acknowledgement.off("error", onAcknowledgementError);
      acknowledgement.off("end", onAcknowledgementClosed);
      acknowledgement.off("close", onAcknowledgementClosed);
      child.off("error", onChildError);
      child.off("exit", onChildExit);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onControlError = () => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap promotion control closed before acknowledgement."
    ));
    const onAcknowledgementError = () => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap promotion acknowledgement pipe failed."
    ));
    const onAcknowledgementClosed = () => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      "Provider bootstrap closed before promotion acknowledgement."
    ));
    const onChildError = (error) => finish(reject, error);
    const onChildExit = (code, signal) => finish(reject, new CompanionError(
      "E_PROVIDER_EXIT",
      `Provider bootstrap exited before promotion acknowledgement (${code ?? signal}).`
    ));
    const onData = (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024) {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap promotion acknowledgement exceeded its limit."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim()) {
        finish(reject, new CompanionError(
          "E_PROTOCOL",
          "Provider bootstrap promotion acknowledgement contained extra data."
        ));
        return;
      }
      let message;
      try { message = JSON.parse(buffer.slice(0, newline)); }
      catch {
        finish(reject, new CompanionError("E_PROTOCOL", "Provider bootstrap promotion acknowledgement was malformed."));
        return;
      }
      try { finish(resolve, assertProviderBootstrapPromotionMessage(message, binding)); }
      catch (error) { finish(reject, error); }
    };
    control.on("error", onControlError);
    acknowledgement.on("data", onData);
    acknowledgement.on("error", onAcknowledgementError);
    acknowledgement.once("end", onAcknowledgementClosed);
    acknowledgement.once("close", onAcknowledgementClosed);
    child.once("error", onChildError);
    child.once("exit", onChildExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onChildExit(child.exitCode, child.signalCode);
      return;
    }
    if (acknowledgement.readableEnded || acknowledgement.destroyed || acknowledgement.closed) {
      onAcknowledgementClosed();
      return;
    }
    try { control.end("promoted\n"); }
    catch { onControlError(); }
  });
}

export function authenticateBoundBootstrapGuard(
  root,
  marker,
  identity,
  binding,
  env = process.env
) {
  return isWorktreeProvisioningBinding(binding)
    ? authenticateWorktreeProvisioningBootstrapGuard(
        root,
        marker,
        identity,
        binding,
        env
      )
    : isWorkerOwnerControllerBinding(binding)
      ? authenticateWorkerOwnerControllerBootstrapGuard(
          root,
          marker,
          identity,
          binding,
          env
        )
    : authenticateProviderBootstrapGuard(root, marker, identity, binding, env);
}

export async function recordBoundBootstrapNoChild({
  providerLaunch,
  preparedLaunch,
  worktreeProvisioning,
  resolution,
  processIdentity = null,
  expectedJournalDigest = null
}) {
  const intentId = preparedLaunch?.intent?.intentId;
  if (!worktreeProvisioning) {
    return providerLaunch.noChild({ intentId, resolution });
  }
  const observedAt = new Date().toISOString();
  const cleanupProof = processIdentity
    ? {
        processIdentity,
        processGroupGone: true,
        providerGuardAbsent: true,
        observedAt
      }
    : null;
  const settlement = await providerLaunch.noChild({
    intentId,
    providerSpawnIntentId: intentId,
    expectedJournalDigest,
    resolution,
    processIdentity,
    cleanupProof
  });
  const job = settlement?.job;
  const durableIntent = job?.provisioningRuntime?.intent;
  const durableProof = job?.provisioningRuntime?.cleanupProof;
  const cleanupBound = processIdentity
    ? (
        durableProof?.processGroupGone === true
        && durableProof?.providerGuardAbsent === true
        && durableProof.processIdentity?.pid === processIdentity.pid
        && durableProof.processIdentity?.startToken === processIdentity.startToken
        && durableProof.processIdentity?.processGroupId === processIdentity.processGroupId
      )
    : durableProof === null;
  const terminalSettled = typeof settlement?.settled === "boolean"
    && typeof settlement?.replayed === "boolean"
    && (settlement.settled || settlement.replayed)
    && job?.status === "failed"
    && job?.provisioning?.state === "failed"
    && durableIntent?.intentId === intentId
    && durableIntent?.providerSpawnIntentId === intentId
    && durableIntent?.status === "no-child"
    && durableIntent?.resolution === resolution
    && cleanupBound;
  const cleanupPendingSettled = Boolean(
    processIdentity
    && typeof settlement?.retained === "boolean"
    && typeof settlement?.replayed === "boolean"
    && (settlement.retained || settlement.replayed)
    && job?.status === "queued"
    && job?.provisioning?.state === "cleanup_pending"
    && job.provisioning.previousJournalDigest === expectedJournalDigest
    && durableIntent?.intentId === intentId
    && durableIntent?.providerSpawnIntentId === intentId
    && durableIntent?.status === "registered"
    && durableIntent?.resolution === null
    && cleanupBound
  );
  if (!terminalSettled && !cleanupPendingSettled) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree provisioning no-child outcome was not durably cleanup-bound."
    );
  }
  return settlement;
}

export async function settleWorktreeBootstrapRegistrationFailure({
  providerLaunch,
  preparedLaunch,
  processIdentity,
  cleanupProof
}) {
  if (typeof providerLaunch?.settleRegistrationFailure !== "function") {
    return Object.freeze({
      reconciled: false,
      retainedPreparedIntent: true
    });
  }
  const outcome = await providerLaunch.settleRegistrationFailure({
    intentId: preparedLaunch.intent.intentId,
    providerSpawnIntentId: preparedLaunch.intent.intentId,
    expectedPlannedJournalDigest:
      preparedLaunch.intent.expectedPlannedJournalDigest,
    processIdentity,
    cleanupProof
  });
  if (outcome?.reconciled !== true) {
    throw new CompanionError(
      "E_PROCESS_IDENTITY",
      "Worktree bootstrap registration failure was not durably reconciled."
    );
  }
  return outcome;
}

export async function cleanupBoundBootstrapStart({
  child,
  identity,
  root,
  marker,
  stagedProfile,
  guardRecord = null,
  guardBinding,
  env = process.env
}) {
  await ensureChildExit(child, identity);
  let exactGuard = guardRecord;
  if (!exactGuard) {
    try {
      const loaded = loadProviderGuard(root, marker);
      exactGuard = loaded
        ? authenticateBoundBootstrapGuard(root, marker, identity, guardBinding, env)
        : null;
    }
    catch (error) { throw attachProviderCleanupIdentity(error, identity); }
  }
  if (exactGuard) {
    try { unregisterProviderGuard(root, marker, exactGuard, env); }
    catch (error) { throw attachProviderCleanupIdentity(error, identity); }
  }
  stagedProfile.cleanup();
}

export async function openProvider({ root, profile, model = null, effort = null, stateDir, jobMarker = "probe", environment = null, knownSecrets = environment?.knownSecrets || [], cancelRequested = () => false, onEvent = () => {}, guardBinding = null, providerLaunch = null, testHooks = null }) {
  assertProviderPlatform();
  const boundBootstrap = Boolean(guardBinding);
  const worktreeProvisioningBootstrap = isWorktreeProvisioningBinding(guardBinding);
  if (worktreeProvisioningBootstrap
    && (
      profile?.id !== "rescue-write-v3"
      || environment?.controllerProfileId !== WORKTREE_CONTROLLER_PROFILE_ID
      || typeof environment?.controllerCwd !== "string"
      || !path.isAbsolute(environment.controllerCwd)
      || fs.realpathSync(environment.controllerCwd)
        !== environment.controllerCwd
      || environment.controllerCwd === root
      || typeof environment.stageCredential !== "function"
      || typeof environment.assertCredentialAbsent !== "function"
      || model !== null
      || effort !== null
    )) {
    throw new CompanionError(
      "E_SECURITY_PROFILE",
      "Worktree provisioning requires the private no-model controller profile."
    );
  }
  const runtimeProfile = worktreeProvisioningBootstrap
    ? Object.freeze({
        ...profile,
        id: WORKTREE_CONTROLLER_PROFILE_ID,
        sandbox: environment.sandboxProfile,
        permissionMode: "dontAsk",
        agentProfileDigest: null
      })
    : profile;
  const providerCwd = worktreeProvisioningBootstrap
    ? environment.controllerCwd
    : root;
  const durableBootstrapCallbacksPresent = !boundBootstrap || (
    typeof providerLaunch?.prepare === "function"
    && typeof providerLaunch?.noChild === "function"
    && (!worktreeProvisioningBootstrap || (
      typeof providerLaunch.registerBootstrap === "function"
      && typeof providerLaunch.settleRegistrationFailure === "function"
    ))
  );
  if (!durableBootstrapCallbacksPresent) {
    if (worktreeProvisioningBootstrap) {
      try {
        environment.revokeCredential();
        environment.assertCredentialAbsent();
      } catch (error) {
        throw new CompanionError(
          "E_STATE",
          "Incomplete worktree bootstrap authority could not revoke its controller credential.",
          { cleanupCode: error?.code || null }
        );
      }
    }
    throw new CompanionError(
      "E_STATE",
      worktreeProvisioningBootstrap
        ? "Worktree provisioning startup requires durable bootstrap registration and reconciliation callbacks."
        : "Bound provider startup requires durable spawn-intent callbacks."
    );
  }
  const discoveredBinary = discoverGrok();
  let binary = discoveredBinary;
  const capturedExecutableIdentity = worktreeProvisioningBootstrap
    ? materializePinnedGrokExecutable(discoveredBinary, {
        directory: path.join(providerCwd, "provider-bin")
      })
    : null;
  if (capturedExecutableIdentity) {
    binary = capturedExecutableIdentity.canonicalPath;
  }
  let version = boundBootstrap ? null : grokVersion(binary);
  const safeMarker = String(jobMarker).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  const leaderSocket = path.join(stateDir, `leader-${safeMarker}-${process.pid}-${Date.now()}.sock`);
  const stagedProfile = materializeAgentProfile(runtimeProfile, environment);
  if (worktreeProvisioningBootstrap) {
    try {
      environment.verifyGitExecutable();
      inspectIsolation(binary, providerCwd, environment);
      environment.verifyGitExecutable();
      environment.assertCredentialAbsent();
    } catch (error) {
      stagedProfile.cleanup();
      try {
        environment.revokeCredential();
        environment.assertCredentialAbsent();
      } catch (cleanupError) {
        throw new CompanionError(
          "E_STATE",
          "Controller isolation failed and its credential could not be revoked.",
          { causeCode: error?.code || null, cleanupCode: cleanupError?.code || null }
        );
      }
      throw error;
    }
  }
  let preparedLaunch = null;
  let resolvedGuardBinding = guardBinding;
  let bootstrapSpecPublication = null;
  let deferredBootstrapSpec = null;
  let provisioningActivation = null;
  let attestedExecutableIdentity =
    capturedExecutableIdentity?.attestation || null;
  let child;
  try {
    if (cancelRequested()) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled before provider process creation.");
    }
    const providerArgs = spawnArgs({
      root: providerCwd,
      profile: runtimeProfile,
      model: worktreeProvisioningBootstrap ? null : model,
      effort: worktreeProvisioningBootstrap ? null : effort,
      leaderSocket,
      taskProfile: stagedProfile.path
    });
    const providerEnv = {
      ...(environment?.env || childEnvironment()),
      GROK_COMPANION_JOB_MARKER: safeMarker
    };
    if (boundBootstrap) {
      const candidate = providerLaunch.prepare(Object.freeze(
        worktreeProvisioningBootstrap
          ? { executableIdentity: capturedExecutableIdentity.attestation }
          : {}
      ));
      if (candidate?.prepared !== true
        || candidate?.intent?.status !== "pending"
        || !EXACT_NONCE_ID.test(candidate.intent.intentId || "")
        || (worktreeProvisioningBootstrap && (
          candidate.intent.purpose !== WORKTREE_PROVISIONING_PURPOSE
          || candidate.intent.providerSpawnIntentId !== candidate.intent.intentId
          || candidate.intent.executionBindingDigest !== guardBinding.executionBindingDigest
          || !SHA256_HEX.test(candidate.intent.expectedPlannedJournalDigest || "")
          || candidate.intent.provisioningAttemptId !== guardBinding.provisioningAttemptId
          || candidate.intent.provisioningFence !== guardBinding.provisioningFence
          || candidate.intent.holderId !== guardBinding.holderId
          || !sameExecutableAttestation(
            candidate.intent.executableIdentity,
            capturedExecutableIdentity.attestation
          )
          || candidate.intent.processIdentity !== null
      ))) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Provider spawn intent was not freshly authorized for this bootstrap.");
      }
      // Only a freshly validated intent belongs to this launch attempt.
      // A replayed, foreign, or malformed pending intent must never be
      // consumed by this caller's no-child settlement path.
      preparedLaunch = candidate;
      resolvedGuardBinding = {
        ...guardBinding,
        providerSpawnIntentId: preparedLaunch.intent.intentId
      };
      await testHooks?.afterProviderIntentCommitted?.(preparedLaunch);
      const bootstrapLaunch = createProviderBootstrapLaunch({
        root: providerCwd,
        marker: safeMarker,
        owner: hostContext().sessionId,
        binding: resolvedGuardBinding,
        binary,
        executableIdentity:
          capturedExecutableIdentity?.attestation || null,
        args: providerArgs
      });
      child = spawn(process.execPath, bootstrapLaunch.argv, {
        cwd: providerCwd,
        env: {
          ...providerEnv,
          GROK_COMPANION_BOOTSTRAP_PLUGIN_DATA: pluginDataRoot(process.env)
        },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
      });
      if (worktreeProvisioningBootstrap) {
        // Keep the child blocked on its private specification pipe until its
        // exact kernel identity has been durably installed as the fenced
        // provisioner. The bootstrap cannot register a guard or create Grok
        // before this callback succeeds.
        deferredBootstrapSpec = bootstrapLaunch.specPayload;
      } else {
        bootstrapSpecPublication = publishProviderBootstrapSpec(child, bootstrapLaunch.specPayload).then(
          () => ({ error: null }),
          (error) => ({ error })
        );
      }
      await testHooks?.afterBootstrapSpawned?.({
        child,
        preparedLaunch,
        providerCwd
      });
    } else {
      child = spawn(binary, providerArgs, {
        cwd: providerCwd,
        env: providerEnv,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    }
  } catch (error) {
    if (preparedLaunch && !child) {
      try {
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: "spawn-not-created",
          expectedJournalDigest: preparedLaunch.intent.expectedPlannedJournalDigest || null
        });
      } catch (settlementError) {
        if (worktreeProvisioningBootstrap) {
          stagedProfile.cleanup();
          throw settlementError;
        }
      }
    }
    stagedProfile.cleanup();
    throw error;
  }
  let processIdentity;
  try { processIdentity = await captureSpawnIdentity(child); }
  catch (error) {
    if (preparedLaunch && !providerCleanupIdentity(error)) {
      try {
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: worktreeProvisioningBootstrap
            ? "spawn-not-created"
            : "cleanup-proven",
          expectedJournalDigest: worktreeProvisioningBootstrap
            ? preparedLaunch.intent.expectedPlannedJournalDigest
            : null
        });
      } catch (settlementError) {
        if (worktreeProvisioningBootstrap) {
          stagedProfile.cleanup();
          throw settlementError;
        }
      }
    }
    if (!providerCleanupIdentity(error)) stagedProfile.cleanup();
    throw error;
  }
  if (worktreeProvisioningBootstrap) {
    try {
      const activation = await providerLaunch.registerBootstrap({
        intentId: preparedLaunch.intent.intentId,
        providerSpawnIntentId: preparedLaunch.intent.intentId,
        expectedJournalDigest: preparedLaunch.intent.expectedPlannedJournalDigest,
        provisioningAttemptId: resolvedGuardBinding.provisioningAttemptId,
        provisioningFence: resolvedGuardBinding.provisioningFence,
        holderId: resolvedGuardBinding.holderId,
        executionBindingDigest: resolvedGuardBinding.executionBindingDigest,
        processIdentity
      });
      provisioningActivation = activation;
      const activatedIntent = activation?.intent;
      const activatedJournal = activation?.job?.provisioning;
      const activatedProvisioner = activatedJournal?.provisioner;
      if (activation?.activated !== true
        || typeof activation.replayed !== "boolean"
        || activatedIntent?.purpose !== WORKTREE_PROVISIONING_PURPOSE
        || activatedIntent.intentId !== preparedLaunch.intent.intentId
        || activatedIntent.providerSpawnIntentId !== preparedLaunch.intent.intentId
        || activatedIntent.executionBindingDigest !== resolvedGuardBinding.executionBindingDigest
        || activatedIntent.expectedPlannedJournalDigest
          !== preparedLaunch.intent.expectedPlannedJournalDigest
        || activatedIntent.provisioningAttemptId !== resolvedGuardBinding.provisioningAttemptId
        || activatedIntent.provisioningFence !== resolvedGuardBinding.provisioningFence
        || activatedIntent.holderId !== resolvedGuardBinding.holderId
        || !["pending", "registered"].includes(activatedIntent.status)
        || activatedIntent.processIdentity?.pid !== processIdentity.pid
        || activatedIntent.processIdentity?.startToken !== processIdentity.startToken
        || activatedIntent.processIdentity?.processGroupId !== processIdentity.processGroupId
        || activatedJournal?.state !== "provisioning"
        || activatedJournal.bindingDigest !== resolvedGuardBinding.executionBindingDigest
        || activatedJournal.attemptId !== resolvedGuardBinding.provisioningAttemptId
        || activatedJournal.fence !== resolvedGuardBinding.provisioningFence
        || activatedProvisioner?.pid !== processIdentity.pid
        || activatedProvisioner?.startToken !== processIdentity.startToken
        || activatedProvisioner?.holderId !== resolvedGuardBinding.holderId) {
        throw new CompanionError(
          "E_PROCESS_IDENTITY",
          "Worktree provisioning bootstrap identity was not durably registered."
        );
      }
      // The bootstrap remains blocked on its private specification pipe until
      // this exact PID/start-token is durable. Publishing credential bytes
      // earlier would leave an ownerless secret if the host died between HOME
      // construction and activation.
      environment.stageCredential();
      bootstrapSpecPublication = publishProviderBootstrapSpec(
        child,
        deferredBootstrapSpec
      ).then(
        () => ({ error: null }),
        (error) => ({ error })
      );
    } catch (error) {
      try {
        await cleanupBoundBootstrapStart({
          child,
          identity: processIdentity,
          root,
          marker: safeMarker,
          stagedProfile,
          guardBinding: resolvedGuardBinding
        });
        const cleanupProof = Object.freeze({
          processIdentity: Object.freeze({ ...processIdentity }),
          processGroupGone: true,
          providerGuardAbsent: true,
          observedAt: new Date().toISOString()
        });
        const registrationSettlement =
          await settleWorktreeBootstrapRegistrationFailure({
          providerLaunch,
          preparedLaunch,
          processIdentity,
          cleanupProof
        });
        if (!registrationSettlement.reconciled) {
          const details = error?.details
            && typeof error.details === "object"
            && !Array.isArray(error.details)
            ? { ...error.details }
            : {};
          details.registrationOutcome = "retained-for-durable-reconciliation";
          details.preparedIntentRetained = true;
          if (error && typeof error === "object") error.details = details;
        }
      } catch (cleanupError) {
        throw attachProviderCleanupIdentity(cleanupError, processIdentity);
      }
      throw error;
    }
  }
  let guardRecord;
  if (boundBootstrap) {
    try {
      const publication = await bootstrapSpecPublication;
      if (publication?.error) throw publication.error;
      const ready = await waitForProviderBootstrapReady(
        child,
        cancelRequested,
        resolvedGuardBinding,
        capturedExecutableIdentity?.attestation || null
      );
      version = ready.version;
      if (worktreeProvisioningBootstrap) {
        attestedExecutableIdentity = ready.executableIdentity
          || capturedExecutableIdentity.attestation;
      }
      guardRecord = authenticateBoundBootstrapGuard(
        root,
        safeMarker,
        processIdentity,
        resolvedGuardBinding
      );
    } catch (error) {
      try {
        await cleanupBoundBootstrapStart({
          child,
          identity: processIdentity,
          root,
          marker: safeMarker,
          stagedProfile,
          guardRecord,
          guardBinding: resolvedGuardBinding
        });
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: "cleanup-proven",
          processIdentity: worktreeProvisioningBootstrap ? processIdentity : null,
          expectedJournalDigest: worktreeProvisioningBootstrap
            ? provisioningActivation?.job?.provisioning?.journalDigest || null
            : null
        });
      } catch (cleanupError) {
        throw attachProviderCleanupIdentity(cleanupError, processIdentity);
      }
      throw error;
    }
  } else {
    try {
      guardRecord = registerProviderGuard(
        root,
        safeMarker,
        processIdentity,
        hostContext().sessionId,
        "provider",
        null
      );
    }
    catch (error) {
      await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile });
      throw error;
    }
  }
  const permissionPolicy = (params) => {
    if (worktreeProvisioningBootstrap) {
      return { outcome: { outcome: "cancelled" } };
    }
    const selected = selectAcpPermissionOption(params?.options, { write: runtimeProfile.id === "rescue-write-v3" });
    return selected?.optionId ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
  };
  let eventError = null;
  const emitEvent = (event) => {
    if (eventError) return;
    try { onEvent(event); }
    catch (error) {
      eventError = error;
      try { process.kill(processIdentity.processGroupId && process.platform !== "win32" ? -processIdentity.processGroupId : child.pid, "SIGTERM"); } catch {}
    }
  };
  try {
    await testHooks?.beforeDispatchPromotion?.({ processIdentity, guardRecord, preparedLaunch });
    emitEvent({
      type: "provider",
      process: processIdentity,
      version,
      ...(preparedLaunch ? { spawnIntentId: preparedLaunch.intent.intentId } : {})
    });
    if (eventError) throw eventError;
  } catch (error) {
    if (boundBootstrap) {
      await cleanupBoundBootstrapStart({
        child,
        identity: processIdentity,
        root,
        marker: safeMarker,
        stagedProfile,
        guardRecord,
        guardBinding: resolvedGuardBinding
      });
      try {
        await recordBoundBootstrapNoChild({
          providerLaunch,
          preparedLaunch,
          worktreeProvisioning: worktreeProvisioningBootstrap,
          resolution: "cleanup-proven",
          processIdentity: worktreeProvisioningBootstrap ? processIdentity : null,
          expectedJournalDigest: worktreeProvisioningBootstrap
            ? provisioningActivation?.job?.provisioning?.journalDigest || null
            : null
        });
      } catch (settlementError) {
        if (worktreeProvisioningBootstrap) {
          throw attachProviderCleanupIdentity(settlementError, processIdentity);
        }
      }
    } else {
      await cleanupFailedProviderStart({
        child,
        identity: processIdentity,
        root,
        marker: safeMarker,
        stagedProfile,
        guardRecord
      });
    }
    throw eventError || error;
  }
  if (boundBootstrap) {
    try {
      await promoteProviderBootstrap(child, {
        marker: safeMarker,
        ...resolvedGuardBinding
      });
    } catch (error) {
      try {
        await cleanupBoundBootstrapStart({
          child,
          identity: processIdentity,
          root,
          marker: safeMarker,
          stagedProfile,
          guardRecord,
          guardBinding: resolvedGuardBinding
        });
        if (worktreeProvisioningBootstrap) {
          await recordBoundBootstrapNoChild({
            providerLaunch,
            preparedLaunch,
            worktreeProvisioning: true,
            resolution: "cleanup-proven",
            processIdentity,
            expectedJournalDigest:
              provisioningActivation?.job?.provisioning?.journalDigest || null
          });
        }
      } catch (cleanupError) {
        throw attachProviderCleanupIdentity(cleanupError, processIdentity);
      }
      throw error;
    }
  }
  const settleWorktreeProvisioningStartupFailure = async () => {
    if (!worktreeProvisioningBootstrap) return;
    await recordBoundBootstrapNoChild({
      providerLaunch,
      preparedLaunch,
      worktreeProvisioning: true,
      resolution: "cleanup-proven",
      processIdentity,
      expectedJournalDigest:
        provisioningActivation?.job?.provisioning?.journalDigest || null
    });
  };
  const client = new AcpClient(child, {
    timeoutMs: 30000,
    permissionPolicy,
    knownSecrets,
    ...(worktreeProvisioningBootstrap
      ? {
          outboundAllowlist: {
            requests: WORKTREE_CONTROLLER_REQUEST_ALLOWLIST,
            notifications: []
          },
          cancelPermissions: true
        }
      : {})
  });
  client.on("update", emitEvent);
  client.on("stderr", (text) => emitEvent({ type: "diagnostic", text: redactText(text, knownSecrets) }));
  let initialized;
  try {
    initialized = await requestDuringProviderStartup(
      client,
      "initialize",
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "grok-companion", version: "0.3.0-dev.1" } },
      30000,
      cancelRequested
    );
    if (eventError) throw eventError;
  } catch (error) {
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw eventError || error;
  }
  if (worktreeProvisioningBootstrap) {
    try {
      environment.revokeCredential();
      environment.assertCredentialAbsent();
    } catch (error) {
      await cleanupFailedProviderStart({
        child,
        identity: processIdentity,
        root,
        marker: safeMarker,
        stagedProfile,
        client,
        guardRecord
      });
      await settleWorktreeProvisioningStartupFailure();
      throw error;
    }
  }
  if (initialized?.protocolVersion !== 1
    || (!worktreeProvisioningBootstrap
      && !initialized?.agentCapabilities?.loadSession)) {
    const error = new CompanionError("E_CAPABILITY", "Grok ACP v1 with session loading is required.");
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw error;
  }
  if (worktreeProvisioningBootstrap) {
    return {
      binary,
      version,
      child,
      client,
      initialized,
      leaderSocket,
      process: processIdentity,
      marker: safeMarker,
      guardRecord,
      emitEvent,
      eventError: () => eventError,
      cleanupAgentProfile: stagedProfile.cleanup,
      controllerCwd: providerCwd,
      controllerProfileId: runtimeProfile.id,
      executableIdentity: attestedExecutableIdentity
    };
  }
  const availableModels = initialized?._meta?.modelState?.availableModels || [];
  const selectedModel = model
    ? availableModels.find((item) => item.modelId === model)
    : availableModels.find((item) => item.modelId === initialized?._meta?.modelState?.currentModelId) || availableModels[0];
  if (model && !selectedModel) {
    const error = new CompanionError("E_CAPABILITY", `Model ${model} is not advertised by Grok.`, { available: availableModels.map((x) => x.modelId) });
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw error;
  }
  const efforts = (selectedModel?._meta?.reasoningEfforts || []).map((item) => item.id);
  if (effort && efforts.length && !efforts.includes(effort)) {
    const error = new CompanionError("E_CAPABILITY", `Reasoning effort ${effort} is not advertised for model ${selectedModel.modelId}.`, { available: efforts });
    await cleanupFailedProviderStart({ child, identity: processIdentity, root, marker: safeMarker, stagedProfile, client, guardRecord });
    await settleWorktreeProvisioningStartupFailure();
    throw error;
  }
  return {
    binary,
    version,
    child,
    client,
    initialized,
    leaderSocket,
    process: processIdentity,
    marker: safeMarker,
    guardRecord,
    emitEvent,
    eventError: () => eventError,
    cleanupAgentProfile: stagedProfile.cleanup
  };
}

export async function ensureChildExit(child, identity, { naturalExitMs = 750 } = {}) {
  // Defense in depth: unsupported platforms must surface E_CAPABILITY before identity failures.
  assertProviderPlatform();
  if (identity?.pid && child.pid === identity.pid && processGroupGone(identity)) return;
  if (!identity?.pid || child.pid !== identity.pid || !identity.startToken) throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to clean up an unverified Grok process tree.", { pid: identity?.pid || child.pid || null });
  if (process.platform !== "win32" && identity.processGroupId !== identity.pid) throw new CompanionError("E_PROCESS_IDENTITY", "Refusing to clean up a Grok process outside its owned process group.", { pid: identity.pid, processGroupId: identity.processGroupId });
  const initialToken = processStartToken(identity.pid);
  if (initialToken && initialToken !== identity.startToken) throw new CompanionError("E_PROCESS_IDENTITY", `Refusing to signal unverified Grok process ${identity.pid}.`, { pid: identity.pid });
  const alive = () => processStartToken(identity.pid) === identity.startToken || (identity.processGroupId && processGroupAlive(identity.processGroupId));
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !alive();
  };
  const signal = (name) => {
    try { process.kill(identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : identity.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  if (await waitGone(naturalExitMs)) return;
  signal("SIGTERM");
  if (await waitGone(1500)) return;
  signal("SIGKILL");
  if (!await waitGone(1500)) throw new CompanionError("E_PROCESS_IDENTITY", `Verified Grok process group ${identity.processGroupId || identity.pid} did not exit after SIGKILL.`, { pid: identity.pid, processGroupId: identity.processGroupId || null });
}

function headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile }) {
  const args = ["--cwd", root, "--agent", "explore", "--sandbox", sandboxProfile, "--permission-mode", "default", "--tools", "todo_write", "--disallowed-tools", "Agent,run_terminal_cmd,read_file,list_dir,grep,search_replace,write,web_search,web_fetch,search_tool,use_tool", "--deny", "MCPTool(*)", "--deny", "Bash(*)", "--deny", "Read(*)", "--deny", "Grep(*)", "--deny", "Edit(*)", "--deny", "Write(*)", "--deny", "WebFetch(*)", "--disable-web-search", "--no-subagents", "--no-memory", "--no-plan", "--leader-socket", leaderSocket];
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else args.push("--session-id", newSessionId);
  if (structured) args.push("--json-schema", JSON.stringify(REVIEW_SCHEMA));
  else args.push("--output-format", "json");
  args.push("--verbatim", "--prompt-file", promptFile);
  return args;
}

function anonymousPrompt(directory, prompt) {
  const temporary = path.join(directory, `prompt-${process.pid}-${crypto.randomBytes(8).toString("hex")}.md`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    fs.unlinkSync(temporary);
    fs.writeSync(fd, String(prompt), 0, "utf8");
    return fd;
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export async function runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker = "review", resumeSessionId = null, structured = false, cancelRequested = () => false, onEvent = () => {}, timeoutMs = 15 * 60 * 1000, maxOutputBytes = 1024 * 1024 }) {
  assertProviderPlatform();
  const binary = discoverGrok(), version = grokVersion(binary);
  const marker = safeMarker(jobMarker), isolation = reviewEnvironment(stateDir, marker);
  const leaderSocket = path.join(stateDir, `leader-${marker}-${process.pid}-${Date.now()}.sock`);
  // Prefer anonymous fd 3 prompts locally. On CI (GitHub Actions sets CI=true), sandbox
  // re-exec cannot re-open /dev/fd/3 reliably ("Bad file descriptor"). Use a mode-0600
  // file under the isolated review home instead; it is removed with that home.
  const forceNamedPrompt = process.env.GROK_HEADLESS_PROMPT_ON_DISK === "1"
    || process.env.CI === "true"
    || process.env.GITHUB_ACTIONS === "true"
    || process.env.GROK_COMPANION_HOST === "ci";
  let promptFile;
  let promptFd = null;
  let namedPromptPath = null;
  if (forceNamedPrompt) {
    // Prefer /tmp so the strict sandbox can always open the prompt path.
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ci-prompt-"));
    namedPromptPath = path.join(promptDir, "prompt.md");
    fs.writeFileSync(namedPromptPath, String(prompt), { mode: 0o600 });
    promptFile = namedPromptPath;
  } else {
    promptFile = process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
    promptFd = anonymousPrompt(isolation.home, prompt);
  }
  const newSessionId = resumeSessionId ? null : crypto.randomUUID();
  const closePromptFd = () => {
    if (promptFd != null) {
      try { fs.closeSync(promptFd); } catch { /* already closed */ }
      promptFd = null;
    }
    if (namedPromptPath) {
      try { fs.rmSync(path.dirname(namedPromptPath), { recursive: true, force: true }); } catch { /* best-effort */ }
      namedPromptPath = null;
    }
  };
  let child;
  try {
    const stdio = forceNamedPrompt
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", promptFd];
    if (cancelRequested()) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled before provider process creation.");
    }
    child = spawn(binary, headlessArgs({ root, promptFile, model, effort, leaderSocket, resumeSessionId, newSessionId, structured, sandboxProfile: isolation.sandboxProfile }), { cwd: root, env: { ...isolation.env, GROK_COMPANION_JOB_MARKER: marker }, shell: false, detached: process.platform !== "win32", stdio });
  } catch (error) {
    closePromptFd();
    throw error;
  }
  let identity;
  try { identity = await captureSpawnIdentity(child); }
  catch (error) {
    closePromptFd();
    const failedIdentity = providerCleanupIdentity(error);
    if (failedIdentity) {
      try { onEvent({ type: "provider", process: failedIdentity, version }); } catch {}
    }
    const cleanup = gatedCleanupReviewEnvironment(stateDir, marker, failedIdentity);
    if (!cleanup.ok && error && typeof error === "object") {
      const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
      details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
      error.details = details;
    }
    throw error;
  }
  let guardRecord;
  try { guardRecord = registerProviderGuard(root, marker, identity, hostContext().sessionId); }
  catch (error) {
    closePromptFd();
    try { await ensureChildExit(child, identity); }
    catch (shutdownError) {
      try { onEvent({ type: "provider", process: identity, version }); } catch {}
      const cleanup = gatedCleanupReviewEnvironment(stateDir, marker, identity);
      const details = shutdownError?.details && typeof shutdownError.details === "object" && !Array.isArray(shutdownError.details)
        ? { ...shutdownError.details }
        : {};
      if (!cleanup.ok) details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
      if (shutdownError && typeof shutdownError === "object") shutdownError.details = details;
      throw attachProviderCleanupIdentity(shutdownError, identity);
    }
    cleanupReviewEnvironment(stateDir, marker);
    throw error;
  }
  let stdout = "", stdoutBytes = 0, stderr = "", terminationReason = null, forceTimer = null, eventError = null;
  const MAX_OUTPUT = maxOutputBytes;
  const terminate = (signal) => { try { process.kill(identity.processGroupId && process.platform !== "win32" ? -identity.processGroupId : child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  const beginTermination = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    terminate("SIGTERM");
    forceTimer = setTimeout(() => { try { terminate("SIGKILL"); } catch {} }, 2000);
  };
  const emitEvent = (event) => {
    if (eventError) return;
    try { onEvent(event); }
    catch (error) { eventError = error; beginTermination("event"); }
  };
  const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (terminationReason === "output") return;
    const bytes = Buffer.byteLength(chunk);
    if (stdoutBytes + bytes > MAX_OUTPUT) { beginTermination("output"); return; }
    stdout += chunk;
    stdoutBytes += bytes;
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); emitEvent({ type: "diagnostic", text: redactText(chunk, isolation.knownSecrets) }); });
  emitEvent({ type: "provider", process: identity, version });
  emitEvent({ type: "session", sessionId: resumeSessionId || newSessionId });
  const cancelPoll = setInterval(() => { if (!terminationReason && cancelRequested()) beginTermination("cancel"); }, 100);
  const timeout = setTimeout(() => beginTermination("timeout"), timeoutMs);
  let code, signal;
  try {
    [code, signal] = await completion;
  } catch (error) {
    throw new CompanionError("E_PROVIDER_EXIT", `Could not start Grok: ${error.message}`);
  } finally {
    clearInterval(cancelPoll); clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer);
    closePromptFd();
    await ensureChildExit(child, identity);
    unregisterProviderGuard(root, marker, guardRecord);
  }
  if (eventError) { cleanupReviewEnvironment(stateDir, marker); throw eventError; }
  if (terminationReason === "cancel") throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
  if (terminationReason === "timeout") throw new CompanionError("E_TIMEOUT", "Grok headless review timed out.");
  if (terminationReason === "output") throw new CompanionError("E_OUTPUT_LIMIT", `Grok headless output exceeded ${MAX_OUTPUT} bytes.`);
  if (code !== 0) {
    const diagnostic = redactText(stderr || stdout, isolation.knownSecrets).slice(-8000);
    if (/login|auth|unauthori[sz]ed|401/i.test(diagnostic)) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is required. Run \`grok login\`, then ${hostCommand("setup")}.`, { diagnostic });
    throw new CompanionError("E_PROVIDER_EXIT", `Grok headless review exited (${code ?? signal}).`, { code, signal, diagnostic });
  }
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new CompanionError("E_PROTOCOL", "Grok headless mode returned malformed JSON."); }
  const sessionId = payload.sessionId || resumeSessionId || newSessionId;
  if (!sessionId) throw new CompanionError("E_PROTOCOL", "Grok headless mode returned no session ID.");
  const expectedSessionId = resumeSessionId || newSessionId;
  if (sessionId !== expectedSessionId) throw new CompanionError("E_PROTOCOL", `Grok returned session ${sessionId} while ${expectedSessionId} was required.`);
  return { sessionId, text: redactText(String(payload.text ?? "").trim(), isolation.knownSecrets), structuredOutput: redact(payload.structuredOutput, isolation.knownSecrets), stopReason: payload.stopReason || "EndTurn", provider: { version, process: identity, isolatedHome: isolation.home }, capabilities: { transport: "headless", agent: "explore", sandbox: isolation.sandboxProfile } };
}

export async function runProvider({ root, profile, prompt, model, effort, stateDir, jobMarker = "job", providerHomeId = null, resumeSessionId = null, cancelRequested = () => false, onEvent = () => {}, guardBinding = null, providerLaunch = null, primaryTurnController = null, mailboxController = null, outputSchema = null, testHooks = null, timeoutMs = undefined }) {
  if (profile.transport === "headless") {
    if (outputSchema != null) {
      throw new CompanionError(
        "E_CAPABILITY",
        "Task structured output requires the ACP provider transport."
      );
    }
    return runHeadless({ root, profile, prompt, model, effort, stateDir, jobMarker, resumeSessionId, cancelRequested, onEvent, ...(timeoutMs == null ? {} : { timeoutMs }) });
  }
  const boundOutputSchemaDigest = outputSchemaDigest(outputSchema);
  const environment = /^rescue-(read|write|report)-v3$/.test(profile.id || "") ? taskEnvironment(stateDir, root, profile, providerHomeId || jobMarker) : null;
  const effectiveProfile = environment?.sandboxProfile ? { ...profile, sandbox: environment.sandboxProfile } : profile;
  const boundProviderLaunch = providerLaunch
    && typeof providerLaunch.prepare === "function"
    && typeof providerLaunch.noChild === "function" ? {
    prepare: (details = {}) => providerLaunch.prepare(Object.freeze({
      ...details,
      promptDigest: crypto.createHash("sha256").update(String(prompt || "")).digest("hex"),
      profileId: effectiveProfile.id,
      profileContractVersion: effectiveProfile.contractVersion,
      agentProfileDigest: effectiveProfile.agentProfileDigest,
      outputSchemaDigest: boundOutputSchemaDigest
    })),
    noChild: (details) => providerLaunch.noChild(details)
  } : providerLaunch;
  try {
    if (environment) inspectIsolation(discoverGrok(), root, environment);
  } catch (error) {
    try { environment?.revokeCredential(); }
    catch (cleanupError) {
      const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
      details.privacyWarning = [details.privacyWarning, `credential: ${redactText(cleanupError?.message || String(cleanupError), environment?.knownSecrets || []).slice(0, 500)}`].filter(Boolean).join("; ");
      if (error && typeof error === "object") error.details = details;
    }
    throw error;
  }
  let provider;
  try {
    provider = await openProvider({
      root,
      profile: effectiveProfile,
      model,
      effort,
      stateDir,
      jobMarker,
      environment,
      cancelRequested,
      onEvent,
      guardBinding,
      providerLaunch: boundProviderLaunch,
      testHooks
    });
  } catch (error) {
    const failedIdentity = providerCleanupIdentity(error);
    if (failedIdentity) {
      try { onEvent({ type: "provider", process: failedIdentity, version: null }); }
      catch (eventError) {
        const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
        details.cleanupWarning = [details.cleanupWarning, `provider identity persistence: ${redactText(eventError?.message || String(eventError)).slice(0, 500)}`].filter(Boolean).join("; ");
        if (error && typeof error === "object") error.details = details;
      }
    }
    // A startup failure with only a PID/PGID witness is deliberately
    // observation-only. The detached group may still be reading its staged
    // credential/profile, so retain both until recovery observes it gone.
    if (!failedIdentity || processGroupGone(failedIdentity)) {
      try { environment?.revokeCredential(); }
      catch (cleanupError) {
        const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? { ...error.details } : {};
        details.privacyWarning = [details.privacyWarning, `credential: ${redactText(cleanupError?.message || String(cleanupError), environment?.knownSecrets || []).slice(0, 500)}`].filter(Boolean).join("; ");
        if (error && typeof error === "object") error.details = details;
      }
    }
    throw error;
  }
  let sessionId = null;
  let poll;
  let killTimer;
  let cancelled = false;
  let outputError = null;
  let outputBytes = 0;
  let primaryTurnAdmission = null;
  let mailboxAttempt = null;
  let mailboxClosed = false;
  try {
    if ((provider.initialized.authMethods || []).some((method) => method?.id === "cached_token")) {
      await requestDuringProviderStartup(
        provider.client,
        "authenticate",
        { methodId: "cached_token", _meta: { headless: true } },
        30000,
        cancelRequested
      );
    }
    const session = resumeSessionId
      ? await requestDuringProviderStartup(
          provider.client,
          "session/load",
          { sessionId: resumeSessionId, cwd: root, mcpServers: [] },
          45000,
          cancelRequested
        )
      : await requestDuringProviderStartup(
          provider.client,
          "session/new",
          { cwd: root, mcpServers: [] },
          45000,
          cancelRequested
        );
    sessionId = session?.sessionId || resumeSessionId;
    if (!sessionId) throw new CompanionError("E_PROTOCOL", "Grok did not return a session ID.");
    if (resumeSessionId && sessionId !== resumeSessionId) throw new CompanionError("E_PROTOCOL", `Grok loaded session ${sessionId} while ${resumeSessionId} was required.`);
    provider.emitEvent({ type: "session", sessionId, models: session?.models });
    if (provider.eventError()) throw provider.eventError();
    // Session creation is authenticated before any model tool can run. Remove the
    // reusable bearer credential before session/prompt exposes workspace tools.
    environment?.revokeCredential();
    if (mailboxController) {
      if (typeof mailboxController.open !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "Attempt-bound mailbox pumping is available only on the primary provider generation."
        );
      }
      mailboxAttempt = await mailboxController.open({
        sessionId,
        providerProcess: provider.process,
        providerCapabilities: provider.initialized
      });
    }
    if (primaryTurnController) {
      if (typeof primaryTurnController.admit !== "function"
        || typeof primaryTurnController.consume !== "function") {
        throw new CompanionError(
          "E_CAPABILITY",
          "Primary provider turns require an exact durable admission controller."
        );
      }
      primaryTurnAdmission = primaryTurnController.admit({
        sessionId,
        providerProcess: provider.process,
        prompt
      });
      if (!primaryTurnAdmission
        || typeof primaryTurnAdmission !== "object"
        || typeof primaryTurnAdmission.then === "function") {
        throw new CompanionError(
          "E_STATE",
          "Primary provider turn admission must be committed synchronously."
        );
      }
      await testHooks?.afterPrimaryTurnAdmitted?.({
        admission: primaryTurnAdmission,
        sessionId,
        providerProcess: provider.process
      });
    }
    // Separate interim chatter (messages before/between tool/plan activity) from the final answer.
    let currentTurn = null;
    const beginTurn = () => {
      const turn = {
        allMessageText: "",
        finalText: "",
        interimText: ""
      };
      currentTurn = turn;
      return {
        text: () => {
          const marker = turn.allMessageText.lastIndexOf("GROK_WORKER_REPORT:");
          return (marker >= 0
            ? turn.allMessageText.slice(marker)
            : turn.finalText).trim();
        },
        interimText: () => {
          const marker = turn.allMessageText.lastIndexOf("GROK_WORKER_REPORT:");
          return (marker >= 0
            ? turn.allMessageText.slice(0, marker)
            : turn.interimText).trim();
        }
      };
    };
    const listener = (event) => {
      if (event.type === "message") {
        const chunk = event.text || "";
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > 512 * 1024) {
          if (!outputError) {
            outputError = new CompanionError("E_OUTPUT_LIMIT", "Grok provider message output exceeded the 512 KiB job limit.", { limitBytes: 512 * 1024 });
            provider.client.notify("session/cancel", { sessionId });
            killTimer = setTimeout(() => {
              try { process.kill(provider.process.processGroupId ? -provider.process.processGroupId : provider.child.pid, "SIGTERM"); } catch {}
            }, 5000);
          }
          return;
        }
        if (currentTurn) {
          currentTurn.allMessageText += chunk;
          currentTurn.finalText += chunk;
        }
        return;
      }
      if (event.type === "tool" || event.type === "plan") {
        if (currentTurn?.finalText) {
          currentTurn.interimText += currentTurn.finalText;
          currentTurn.finalText = "";
        }
      }
    };
    provider.client.on("update", listener);
    poll = setInterval(() => { if (!cancelled && cancelRequested()) { cancelled = true; provider.client.notify("session/cancel", { sessionId }); killTimer = setTimeout(() => { try { process.kill(provider.process.processGroupId ? -provider.process.processGroupId : provider.child.pid, "SIGTERM"); } catch {} }, 5000); } }, 100);
    let result;
    let structuredOutput;
    let structuredOutputError;
    const primaryCollector = beginTurn();
    try {
      if (primaryTurnController) {
        const consumed = primaryTurnController.consume({
          admission: primaryTurnAdmission,
          sessionId,
          providerProcess: provider.process,
          prompt
        });
        if (!consumed
          || typeof consumed !== "object"
          || typeof consumed.then === "function") {
          throw new CompanionError(
            "E_STATE",
            "Primary provider turn admission must be consumed synchronously."
          );
        }
      }
      const promptResponse = await provider.client.promptTurn({
        sessionId,
        prompt: [{ type: "text", text: prompt }],
        outputSchema,
        timeoutMs: timeoutMs ?? 30 * 60 * 1000
      });
      result = promptResponse.result;
      if (Object.hasOwn(promptResponse, "structuredOutput")) {
        structuredOutput = promptResponse.structuredOutput;
      }
      if (Object.hasOwn(promptResponse, "structuredOutputError")) {
        structuredOutputError = promptResponse.structuredOutputError;
      }
    }
    catch (error) { if (outputError) throw outputError; if (cancelled) throw new CompanionError("E_CANCELLED", "Grok job was cancelled."); throw provider.eventError() || error; }
    if (provider.eventError()) throw provider.eventError();
    if (outputError) throw outputError;
    if (cancelled
      || cancelRequested()
      || isCancelledPromptStopReason(result?.stopReason)) {
      throw new CompanionError("E_CANCELLED", "Grok job was cancelled.");
    }
    if (!isSuccessfulPromptStopReason(result?.stopReason)) {
      throw new CompanionError(
        "E_PROTOCOL",
        "Grok prompt did not end at a successful ACP turn boundary."
      );
    }
    const secrets = environment?.knownSecrets || [];
    let resolvedFinal = primaryCollector.text();
    let resolvedInterim = primaryCollector.interimText();
    let selectedSequence = 0;
    let mailboxEvidence = null;
    if (mailboxController) {
      await mailboxController.recordPrimary({
        attempt: mailboxAttempt,
        prompt,
        stopReason: result?.stopReason || "end_turn"
      });
      const drained = await mailboxController.drain({
        attempt: mailboxAttempt,
        client: provider.client,
        sessionId,
        collectTurnText: beginTurn,
        timeoutMs: timeoutMs ?? 30 * 60 * 1000,
        cancelRequested
      });
      if (cancelled || cancelRequested()) {
        throw new CompanionError(
          "E_CANCELLED",
          "Grok job was cancelled after mailbox drain."
        );
      }
      mailboxClosed = drained?.closed === true;
      const deliveredTurns = Array.isArray(drained?.turns)
        ? drained.turns.filter((turn) => turn?.outcome === "delivered")
        : [];
      if (drained?.deliveryUnknown === true) {
        // Never reuse an earlier report when the last attempted turn is
        // ambiguous. The controller will fail the provider-success claim.
        resolvedFinal = "";
        resolvedInterim = "";
        selectedSequence = drained?.attempt?.lastCompletedSequence ?? selectedSequence;
        structuredOutput = undefined;
        structuredOutputError = undefined;
      } else if (deliveredTurns.length) {
        const selected = deliveredTurns.at(-1);
        selectedSequence = selected.sequence;
        resolvedFinal = String(selected.text || "").trim();
        resolvedInterim = "";
        structuredOutput = undefined;
        structuredOutputError = undefined;
      }
      mailboxEvidence = {
        schemaVersion: 1,
        attemptId: mailboxAttempt.dispatchAttemptId,
        communicationChainDigest: drained?.attempt?.communicationChainDigest || null,
        lastCompletedSequence: drained?.attempt?.lastCompletedSequence ?? null,
        selectedSequence,
        acceptedCount: drained?.attempt?.acceptedCount ?? 0,
        acceptedBytes: drained?.attempt?.acceptedBytes ?? 0,
        deliveryUnknown: drained?.deliveryUnknown === true,
        closed: mailboxClosed,
        bodiesRetained: Boolean(drained?.bodiesRetained)
      };
    }
    clearInterval(poll); poll = null; provider.client.off("update", listener);
    return {
      sessionId,
      text: redactText(resolvedFinal, secrets),
      interimText: redactText(resolvedInterim, secrets),
      stopReason: result?.stopReason || "end_turn",
      provider: { version: provider.version, process: provider.process },
      capabilities: provider.initialized,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(structuredOutputError !== undefined ? { structuredOutputError } : {}),
      ...(mailboxEvidence ? { mailboxEvidence } : {})
    };
  } catch (error) {
    if (mailboxController && mailboxAttempt && !mailboxClosed) {
      try {
        await mailboxController.interrupt({
          attempt: mailboxAttempt,
          reason: error?.code === "E_CANCELLED"
            ? "provider-cancelled"
            : "provider-interrupted"
        });
      } catch (mailboxError) {
        const details = error?.details && typeof error.details === "object"
          && !Array.isArray(error.details)
          ? { ...error.details }
          : {};
        details.mailboxWarning = redactText(mailboxError?.message || String(mailboxError)).slice(0, 500);
        if (error && typeof error === "object") error.details = details;
      }
    }
    if (/auth|login|unauthori[sz]ed|no auth method/i.test(`${error?.message || ""} ${error?.details?.data || ""}`)) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is unavailable or expired. Run \`grok login\`, then ${hostCommand("setup")}.`);
    throw provider.eventError() || error;
  } finally {
    if (poll) clearInterval(poll);
    if (killTimer) clearTimeout(killTimer);
    const cleanupWarnings = [];
    const noteCleanupFailure = (label, error) => {
      cleanupWarnings.push(`${label}: ${redactText(error?.message || String(error), environment?.knownSecrets || []).slice(0, 500)}`);
    };
    try { environment?.revokeCredential(); }
    catch (error) { noteCleanupFailure("credential", error); }
    try { provider.client.close(); }
    catch (error) { noteCleanupFailure("ACP client", error); }

    try {
      await ensureChildExit(provider.child, provider.process);
    } catch (error) {
      if (cleanupWarnings.length && error && typeof error === "object") {
        const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
          ? { ...error.details }
          : {};
        details.privacyWarning = [details.privacyWarning, ...cleanupWarnings].filter(Boolean).join("; ");
        error.details = details;
      }
      // The provider may still be using the guard/profile. Retain both until a
      // later status/cancel recovery proves the complete process group is gone.
      throw error;
    }

    let guardRemoved = false;
    try {
      unregisterProviderGuard(root, provider.marker, provider.guardRecord);
      guardRemoved = true;
    } catch (error) {
      noteCleanupFailure("provider guard", error);
    }
    // An exact guard mismatch means another provider generation may own the
    // marker. Its process can still be reading the staged profile, so preserve
    // that profile for host recovery rather than unlinking it under ambiguity.
    if (guardRemoved) {
      try { provider.cleanupAgentProfile?.(); }
      catch (error) { noteCleanupFailure("agent profile", error); }
    }
    if (cleanupWarnings.length) {
      throw new CompanionError("E_STATE", "Grok provider exited, but transient task runtime cleanup was incomplete.", {
        privacyWarning: cleanupWarnings.join("; ")
      });
    }
  }
}

export async function runStructuredReview(options) {
  const execute = (values) => values.profile?.transport === "headless" ? runHeadless({ ...values, structured: true }) : runProvider(values);
  let run = await execute(options), parsed = run.structuredOutput ?? extractJson(run.text);
  try { return { ...run, review: validateReview(parsed) }; }
  catch (firstError) {
    const repair = await execute({
      ...options,
      resumeSessionId: run.sessionId,
      prompt: "Your previous response was not valid review JSON. Return only one JSON object with exactly summary and findings. Omit verdict; the runtime derives pass from zero findings and needs_changes from one or more findings. Preserve substantive findings and use repository-relative paths."
    });
    parsed = repair.structuredOutput ?? extractJson(repair.text);
    try {
      return { ...repair, review: validateReview(parsed) };
    } catch (repairError) {
      const details = {
        ...(repairError?.details && typeof repairError.details === "object" ? repairError.details : {}),
        firstError: firstError?.code || null,
        repairAttempted: true,
        attempts: 2,
        jobId: options.jobMarker || null
      };
      throw new CompanionError(
        repairError?.code || "E_SCHEMA",
        repairError?.message || "Grok review repair still did not match the required schema.",
        details
      );
    }
  }
}

export function deleteSession(sessionId, binary = null, env = null) {
  if (!sessionId) return { ok: true, removed: false, warning: null };
  const run = spawnSync(
    binary || discoverGrok(),
    ["sessions", "delete", sessionId],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      shell: false,
      env: env || childEnvironment()
    }
  );
  const stdout = String(run.stdout || "");
  const stderr = String(run.stderr || "");
  const acknowledged = (
    run.status === 0
    && !run.error
    && !run.signal
    && stderr === ""
    && (stdout === `Deleted session ${sessionId}\n`
      || stdout === `Deleted session ${sessionId}\r\n`)
  );
  return {
    ok: acknowledged,
    removed: acknowledged,
    warning: acknowledged ? null : redactText(stderr || stdout)
  };
}

function shellWord(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Executable resume argv for an imported Grok session.
 * Model is required: legacy placeholder models on import otherwise resume empty.
 */
export function formatResumeCommand(sessionId, model, effort = null) {
  if (!sessionId) throw new CompanionError("E_IMPORT_RESULT", "Cannot format a resume command without a Grok session ID.");
  if (!model) throw new CompanionError("E_CAPABILITY", "Cannot format a resume command without an advertised Grok model.");
  const parts = ["grok", "--model", model];
  if (effort) parts.push("--reasoning-effort", effort);
  parts.push("--resume", sessionId);
  return parts.map(shellWord).join(" ");
}

/**
 * Parse `grok models` text from the non-isolated CLI home used by import/resume.
 * Optional trailing `efforts=a,b` is recognized when a provider prints it (tests);
 * production Grok text may omit efforts, in which case advertised effort checks are skipped.
 */
export function parseAdvertisedModels(text) {
  const models = [];
  let defaultId = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const defaultMatch = line.match(/^Default model:\s+(\S+)\s*$/i);
    if (defaultMatch) {
      defaultId = defaultMatch[1];
      continue;
    }
    const modelMatch = line.match(/^[*-]\s+(\S+)(?:\s+\(default\))?(?:\s+efforts=([A-Za-z0-9_,-]+))?\s*$/i);
    if (!modelMatch) continue;
    const id = modelMatch[1];
    const efforts = modelMatch[2]
      ? modelMatch[2].split(",").map((item) => item.trim()).filter(Boolean)
      : [];
    if (!models.some((item) => item.id === id)) models.push({ id, efforts });
    if (/\(default\)/i.test(line)) defaultId = id;
  }
  if (defaultId) {
    const index = models.findIndex((item) => item.id === defaultId);
    if (index > 0) {
      const [preferred] = models.splice(index, 1);
      models.unshift(preferred);
    } else if (index < 0) {
      models.unshift({ id: defaultId, efforts: [] });
    }
  }
  return models;
}

/**
 * List models advertised by the same non-isolated Grok home used for import and resume.
 * Does not open an isolated setup-probe ACP home.
 */
export function listAdvertisedModels(binary = null, env = null) {
  assertProviderPlatform();
  const resolved = binary || discoverGrok();
  const run = spawnSync(resolved, ["models"], {
    encoding: "utf8",
    shell: false,
    timeout: 30000,
    env: env || childEnvironment()
  });
  if (run.status !== 0) {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      `Grok authentication is unavailable or expired. Run \`grok login\`, then retry ${hostCommand("setup")}.`,
      { diagnostic: redactText(run.stderr || run.stdout).slice(-2000) }
    );
  }
  const models = parseAdvertisedModels(`${run.stdout || ""}\n${run.stderr || ""}`);
  if (!models.length) {
    throw new CompanionError("E_CAPABILITY", "Grok did not advertise a model that can resume the imported session.");
  }
  return models;
}

export function selectTransferModel(models, requestedModel = null) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) {
    throw new CompanionError("E_CAPABILITY", "Grok did not advertise a model that can resume the imported session.");
  }
  if (requestedModel) {
    const selected = list.find((item) => item.id === requestedModel);
    if (!selected) {
      throw new CompanionError("E_CAPABILITY", `Model ${requestedModel} is not advertised by Grok.`, {
        available: list.map((item) => item.id)
      });
    }
    return selected;
  }
  return list[0];
}

export function assertTransferEffort(selected, effort = null) {
  if (!effort) return;
  const efforts = Array.isArray(selected?.efforts) ? selected.efforts : [];
  if (efforts.length && !efforts.includes(effort)) {
    throw new CompanionError("E_CAPABILITY", `Reasoning effort ${effort} is not advertised for model ${selected.id}.`, {
      available: efforts
    });
  }
}

/**
 * Observe whether one exact session ID appears in a successful non-isolated
 * Grok session list. `ok:false` preserves list failure separately from a
 * successful absence proof. Only provider metadata is requested or retained.
 */
export function inspectImportedSessionPresence(sessionId, binary = null, env = null, cwd = null) {
  const canonicalSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const canonicalDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed)
      && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  if (typeof sessionId !== "string"
    || !canonicalSessionId.test(sessionId)) {
    return Object.freeze({ ok: false, present: false });
  }
  const resolved = binary || discoverGrok();
  const run = spawnSync(resolved, ["sessions", "list", "-n", "200"], {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    shell: false,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: env || childEnvironment()
  });
  if (run.status !== 0 || run.error || String(run.stderr || "").trim() !== "") {
    return Object.freeze({ ok: false, present: false });
  }
  const lines = String(run.stdout || "").split(/\r?\n/);
  const nonemptyLines = lines.map((line) => line.trim()).filter(Boolean);
  if (
    nonemptyLines.length === 1
    && nonemptyLines[0] === "No sessions found."
  ) {
    return Object.freeze({ ok: true, present: false });
  }
  const observed = new Set();
  let present = false;
  let headers = 0;
  let inTable = false;
  let expectingHeader = false;
  let tableHasSummary = false;
  let currentGroupLabel = null;
  let currentTableRows = 0;
  const observedGroupLabels = new Set();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    const columns = line.split(/\s+/);
    const header = (
      (columns.length === 5 || columns.length === 6)
      && columns[0] === "SESSION"
      && columns[1] === "ID"
      && columns[2] === "CREATED"
      && columns[3] === "UPDATED"
      && columns[4] === "STATUS"
      && (columns.length === 5 || columns[5] === "SUMMARY")
    );
    if (header) {
      if (inTable && !expectingHeader) {
        return Object.freeze({ ok: false, present: false });
      }
      headers += 1;
      inTable = true;
      expectingHeader = false;
      tableHasSummary = columns.length === 6;
      currentTableRows = 0;
      continue;
    }
    if (
      /^\([^()\r\n]{1,256}\)$/.test(line)
      || /^Label: [^\r\n]{1,256}$/.test(line)
    ) {
      if (
        expectingHeader
        || (inTable && currentGroupLabel === null)
        || (currentGroupLabel !== null && currentTableRows === 0)
        || observedGroupLabels.has(line)
      ) {
        return Object.freeze({ ok: false, present: false });
      }
      observedGroupLabels.add(line);
      currentGroupLabel = line;
      inTable = false;
      expectingHeader = true;
      continue;
    }
    if (!inTable || expectingHeader) {
      return Object.freeze({ ok: false, present: false });
    }
    const id = columns[0];
    const normalizedId = typeof id === "string" ? id.toLowerCase() : "";
    const minimumColumns = tableHasSummary ? 5 : 4;
    if ((tableHasSummary ? columns.length < minimumColumns : columns.length !== minimumColumns)
      || !canonicalSessionId.test(id || "")
      || !canonicalDate(columns[1])
      || !canonicalDate(columns[2])
      || !/^[A-Za-z][A-Za-z0-9._:+-]{0,63}$/.test(columns[3] || "")
      || observed.has(normalizedId)) {
      return Object.freeze({ ok: false, present: false });
    }
    observed.add(normalizedId);
    currentTableRows += 1;
    if (normalizedId === sessionId.toLowerCase()) present = true;
  }
  if (
    headers === 0
    || expectingHeader
    || currentTableRows === 0
  ) {
    return Object.freeze({ ok: false, present: false });
  }
  if (!present && observed.size >= 200) {
    return Object.freeze({ ok: false, present: false });
  }
  return Object.freeze({ ok: true, present });
}

/**
 * Backward-compatible readiness predicate. Qualification code must use
 * inspectImportedSessionPresence so list failure is not mistaken for absence.
 */
export function isImportedSessionReady(sessionId, binary = null, env = null, cwd = null) {
  const observation = inspectImportedSessionPresence(sessionId, binary, env, cwd);
  return observation.ok && observation.present;
}

/**
 * Fail closed until the exact imported session is observable for resume.
 * Bounded polling accounts for Grok import persistence races.
 */
export async function waitForImportedSession(sessionId, {
  binary = null,
  env = null,
  cwd = null,
  signal = null,
  timeoutMs = null,
  intervalMs = null
} = {}) {
  assertProviderPlatform();
  if (!sessionId) throw new CompanionError("E_IMPORT_RESULT", "Grok import returned no usable session ID.");
  const testTimeout = Number(process.env.GROK_COMPANION_TEST_IMPORT_READY_TIMEOUT_MS);
  const testInterval = Number(process.env.GROK_COMPANION_TEST_IMPORT_READY_INTERVAL_MS);
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : (Number.isFinite(testTimeout) && testTimeout > 0 ? testTimeout : 10_000);
  const stepMs = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : (Number.isFinite(testInterval) && testInterval > 0 ? testInterval : 100);
  const resolved = binary || discoverGrok();
  const deadline = Date.now() + limitMs;
  while (true) {
    if (signal?.aborted) throw new CompanionError("E_CANCELLED", "Grok transcript import was cancelled while waiting for session readiness.");
    if (isImportedSessionReady(sessionId, resolved, env, cwd)) return true;
    if (Date.now() >= deadline) {
      throw new CompanionError(
        "E_IMPORT_RESULT",
        `Grok import reported session ${sessionId}, but the session is not yet observable for resume.`,
        { sessionId }
      );
    }
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, Math.max(0, remaining))));
  }
}

export async function probe(root, stateDir) {
  assertProviderPlatform();
  const binary = discoverGrok();
  grokVersion(binary);
  const help = spawnSync(binary, ["--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const helpText = `${help.stdout || ""}\n${help.stderr || ""}`;
  const requiredFlags = ["--prompt-file", "--json-schema", "--tools", "--disallowed-tools", "--sandbox"];
  const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
  if (help.status !== 0 || missingFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required headless review flags.", { missing: missingFlags });
  const agentHelp = spawnSync(binary, ["agent", "--help"], { encoding: "utf8", shell: false, timeout: 15000, env: childEnvironment() });
  const agentHelpText = `${agentHelp.stdout || ""}\n${agentHelp.stderr || ""}`;
  const requiredAgentFlags = ["--agent-profile", "--no-leader", "--leader-socket"];
  const missingAgentFlags = requiredAgentFlags.filter((flag) => !agentHelpText.includes(flag));
  if (agentHelp.status !== 0 || missingAgentFlags.length) throw new CompanionError("E_CAPABILITY", "Grok does not advertise the required isolated ACP agent flags.", { missing: missingAgentFlags });
  const auth = spawnSync(binary, ["models"], { encoding: "utf8", shell: false, timeout: 30000, env: childEnvironment() });
  if (auth.status !== 0) throw new CompanionError("E_AUTH_REQUIRED", `Grok authentication is unavailable or expired. Run \`grok login\`, then retry ${hostCommand("setup")}.`, { diagnostic: redactText(auth.stderr || auth.stdout).slice(-2000) });
  const marker = `setup-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const isolation = reviewEnvironment(stateDir, marker);
  let provider = null;
  let failedProviderProcess = null;
  let primaryError = null;
  try {
    inspectIsolation(binary, root, isolation);
    const agentProfilePath = path.join(PLUGIN_ROOT, "provider-agents", "setup-probe.md");
    const agentProfile = fs.readFileSync(agentProfilePath, "utf8");
    if (!/^injectDefaultTools:\s*false\s*$/m.test(agentProfile)) throw new CompanionError("E_SECURITY_PROFILE", "The checked-in setup probe agent profile must set injectDefaultTools: false.");
    if (!/^permission_mode:\s*dontAsk\s*$/m.test(agentProfile)) throw new CompanionError("E_SECURITY_PROFILE", "The checked-in setup probe agent profile must use permission_mode dontAsk without unattended privilege expansion.");
    const agentProfileDigest = crypto.createHash("sha256").update(agentProfile).digest("hex");
    const profile = {
      id: "setup-probe-v2",
      contractVersion: 2,
      transport: "acp",
      sandbox: "read-only",
      permissionMode: "dontAsk",
      webSearch: false,
      subagents: false,
      isolatedLeader: true,
      agentProfileDigest,
      allowedTools: ["todo_write"],
      deniedTools: ["WebSearch", "WebFetch", "Agent", "mcp__*", "Bash", "Edit", "Write"]
    };
    provider = await openProvider({ root, profile, stateDir, jobMarker: marker, environment: isolation });
    return {
      binary: provider.binary,
      version: provider.version,
      authenticated: true,
      headlessReview: { flags: requiredFlags, isolated: true, externalHooks: 0, externalSkills: 0, externalPlugins: 0, externalMcpServers: 0 },
      acpIsolation: {
        flags: requiredAgentFlags,
        isolated: true,
        sandbox: profile.sandbox,
        permissionMode: profile.permissionMode,
        injectDefaultTools: false,
        allowedTools: [...profile.allowedTools],
        agentProfileDigest,
        unattendedPrivilegeExpansion: false
      },
      protocolVersion: provider.initialized.protocolVersion,
      loadSession: Boolean(provider.initialized.agentCapabilities?.loadSession),
      authMethods: (provider.initialized.authMethods || []).map((x) => ({ id: x.id, name: x.name })),
      models: (provider.initialized?._meta?.modelState?.availableModels || []).map((x) => ({ id: x.modelId, efforts: (x._meta?.reasoningEfforts || []).map((e) => e.id) }))
    };
  } catch (error) {
    primaryError = error;
    failedProviderProcess = providerCleanupIdentity(error);
    throw error;
  } finally {
    let shutdownError = null;
    let retainProfileForGuard = false;
    if (provider) {
      provider.client.close();
      try {
        await ensureChildExit(provider.child, provider.process);
        try {
          unregisterProviderGuard(root, provider.marker, provider.guardRecord);
        } catch (error) {
          retainProfileForGuard = true;
          throw error;
        }
        provider.cleanupAgentProfile?.();
      } catch (error) {
        shutdownError = error;
      }
    }
    // Never delete the isolated credential home while the recorded process group remains live
    // or shutdown is unverifiable. Preserve the guard (unregister only after verified exit)
    // and keep the primary shutdown error when present.
    const cleanupIdentity = provider?.process || failedProviderProcess;
    const cleanup = retainProfileForGuard
      ? {
          ok: false,
          warning: "Isolated review home retained because exact provider guard cleanup failed."
        }
      : gatedCleanupReviewEnvironment(stateDir, marker, cleanupIdentity);
    if (!cleanup.ok) {
      const surfacedError = shutdownError || primaryError;
      if (surfacedError) {
        const details = surfacedError.details && typeof surfacedError.details === "object" && !Array.isArray(surfacedError.details)
          ? { ...surfacedError.details }
          : {};
        details.privacyWarning = [details.privacyWarning, cleanup.warning].filter(Boolean).join("; ");
        surfacedError.details = details;
        throw surfacedError;
      }
      if (cleanupIdentity && !processGroupGone(cleanupIdentity)) {
        throw new CompanionError("E_PROCESS_IDENTITY", "Could not verify complete process-group shutdown for the setup review-isolation probe.", {
          pid: cleanupIdentity.pid,
          processGroupId: cleanupIdentity.processGroupId ?? null,
          privacyWarning: cleanup.warning
        });
      }
      throw new CompanionError("E_STATE", "Could not remove the setup review-isolation probe.", { warning: cleanup.warning });
    }
    if (shutdownError) throw shutdownError;
  }
}
