// Installed Worker MCP qualification domain. Keep import-time behavior inert.
import { INSTALLED_WORKER_MCP_ERROR_MESSAGES } from "./installed-worker-mcp-failure.mjs";
import { boundedSetupScanDiagnosticCode } from "./installed-worker-mcp-setup-boundary.mjs";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SOURCE_PLUGIN = path.join(ROOT, "plugins", "grok");
export const PLUGIN_ID = "grok@grok-companion";
export const MARKETPLACE_ID = "grok-companion";
export const PROTOCOL_VERSION = "2025-11-25";
export const RUNNER_VERSION = "1";
export const EXPECTED_EXPERIMENTAL_CAPABILITIES = Object.freeze({
  "codex/sandbox-state-meta": Object.freeze({}),
  "grok/worker-change-notifications": Object.freeze({})
});
export const HELP = "Usage: GROK_E2E=1 GROK_INSTALLED_WORKER_MCP_E2E=1 GROK_E2E_CANCEL=1 npm run test:installed-worker-mcp\n";
export const WRITE_SMOKE_HELP = "Usage: GROK_E2E=1 GROK_INSTALLED_WORKER_MCP_E2E=1 GROK_E2E_CANCEL=1 GROK_WORKER_WRITE_E2E=1 npm run test:installed-worker-mcp -- --write-smoke\n";
export const TWO_WRITER_HELP = "Usage: GROK_E2E=1 GROK_INSTALLED_WORKER_MCP_E2E=1 GROK_E2E_CANCEL=1 GROK_WORKER_WRITE_E2E=1 GROK_WORKER_TWO_WRITER_E2E=1 npm run test:installed-worker-mcp:two-writer\n";
export const LIVE_GATES = Object.freeze([
  "GROK_E2E",
  "GROK_INSTALLED_WORKER_MCP_E2E",
  "GROK_E2E_CANCEL"
]);
export const TWO_WRITER_TOOLS = Object.freeze({
  preview: "worker_preview",
  verify: "worker_verify_integration",
  abandon: "worker_abandon"
});
export const WRITE_VERTICAL_TOOL_NAMES = new Set([
  "worker_spawn_write",
  "worker_artifact",
  TWO_WRITER_TOOLS.preview,
  "worker_integrate",
  TWO_WRITER_TOOLS.verify,
  TWO_WRITER_TOOLS.abandon,
  "worker_cleanup"
]);
export const RPC_TIMEOUT_MS = 35_000;
export const MCP_SHUTDOWN_TIMEOUT_MS = 2_000;
export const SCENARIO_TIMEOUT_MS = 20 * 60_000;
export const ACTIVE_WINDOW_WORKLOAD_FILES = 8;
export const TERMINAL_PROCESS_CLOSURE_TIMEOUT_MS = 30_000;
export const STATE_POLL_MS = 100;
export const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RECEIPT_BYTES = 1024 * 1024;
export const MAX_TERMINAL_LIFECYCLE_EVENTS = 128;
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const FIXED_ERRORS = INSTALLED_WORKER_MCP_ERROR_MESSAGES;
export const QUALIFICATION_STAGES = new Set([
  "startup",
  "source-boundary",
  "private-install",
  "installed-imports",
  "provider-setup",
  "provider-setup-command",
  "provider-setup-cleanup",
  "provider-setup-contract",
  "provider-discovery-poison",
  "provider-capability",
  "completion-mcp-surface",
  "completion-spawn",
  "completion-owned-list",
  "completion-spawn-call",
  "completion-spawn-private",
  "completion-spawn-witness",
  "completion-spawn-handle-project",
  "completion-spawn-handle-binding",
  "completion-spawn-handle-shape",
  "completion-spawn-handle-order",
  "completion-spawn-handle-mode",
  "completion-spawn-handle-state",
  "completion-spawn-handle-text",
  "completion-spawn-handle-start",
  "completion-spawn-handle-cursor",
  "completion-spawn-handle-time",
  "completion-spawn-handle-tracker",
  "completion-spawn-handle-replay",
  "completion-spawn-witness-read",
  "completion-spawn-witness-contract",
  "completion-spawn-witness-record",
  "completion-spawn-witness-binding",
  "completion-spawn-witness-handle",
  "completion-spawn-witness-time",
  "completion-spawn-witness-id",
  "completion-get",
  "completion-events",
  "completion-mailbox-open",
  "completion-send-first",
  "completion-send-second",
  "completion-send-replay",
  "completion-wait",
  "completion-result",
  "completion-cleanup-private",
  "completion-terminal-drain",
  "completion-cleanup-snapshot",
  "completion-cleanup-events",
  "completion-cleanup-binding",
  "completion-cleanup-identity",
  "completion-cleanup-report",
  "completion-mailbox-proof",
  "completion-session-id",
  "completion-session-binding",
  "completion-session-credential-revoked",
  "completion-session-presence",
  "completion-session-delete",
  "completion-session-absence",
  "completion-session-cleanup-credential-revoked",
  "completion-contract",
  "cancellation-mcp-surface",
  "cancellation-spawn",
  "cancellation-owned-list",
  "cancellation-spawn-call",
  "cancellation-spawn-private",
  "cancellation-spawn-witness",
  "cancellation-spawn-handle-project",
  "cancellation-spawn-handle-binding",
  "cancellation-spawn-handle-shape",
  "cancellation-spawn-handle-order",
  "cancellation-spawn-handle-mode",
  "cancellation-spawn-handle-state",
  "cancellation-spawn-handle-text",
  "cancellation-spawn-handle-start",
  "cancellation-spawn-handle-cursor",
  "cancellation-spawn-handle-time",
  "cancellation-spawn-handle-tracker",
  "cancellation-spawn-handle-replay",
  "cancellation-spawn-witness-read",
  "cancellation-spawn-witness-contract",
  "cancellation-spawn-witness-record",
  "cancellation-spawn-witness-binding",
  "cancellation-spawn-witness-handle",
  "cancellation-spawn-witness-time",
  "cancellation-spawn-witness-id",
  "cancellation-get",
  "cancellation-events",
  "cancellation-live-provider",
  "cancellation-reconnect",
  "cancellation-replay",
  "cancellation-request",
  "cancellation-wait",
  "cancellation-result",
  "cancellation-cleanup-private",
  "cancellation-terminal-drain",
  "cancellation-cleanup-snapshot",
  "cancellation-cleanup-events",
  "cancellation-cleanup-binding",
  "cancellation-cleanup-identity",
  "cancellation-cleanup-report",
  "cancellation-session-id",
  "cancellation-session-binding",
  "cancellation-session-credential-revoked",
  "cancellation-session-presence",
  "cancellation-session-delete",
  "cancellation-session-absence",
  "cancellation-session-cleanup-credential-revoked",
  "cancellation-contract",
  "global-cleanup",
  "installed-recheck",
  "evidence-binding",
  "receipt-publication",
  "write-smoke-fixture",
  "write-smoke-mcp-surface",
  "write-smoke-spawn",
  "write-smoke-wait",
  "write-smoke-result",
  "write-smoke-artifact",
  "write-smoke-parent",
  "write-smoke-private",
  "write-smoke-spawn-reconnect",
  "write-smoke-spawn-replay",
  "write-smoke-artifact-replay",
  "write-smoke-integration",
  "write-smoke-integration-reconnect",
  "write-smoke-production-cleanup",
  "write-smoke-session-absence",
  "write-smoke-cleanup-reconnect",
  "write-smoke-artifact-post-cleanup",
  "write-smoke-cleanup",
  "write-two-fixture",
  "write-two-mcp-surface",
  "write-two-spawn",
  "write-two-dispatch",
  "write-two-overlap",
  "write-two-wait",
  "write-two-result",
  "write-two-artifact",
  "write-two-parent",
  "write-two-preview",
  "write-two-retention-reconnect",
  "write-two-integration",
  "write-two-verification",
  "write-two-conflict",
  "write-two-abandon",
  "write-two-cleanup",
  "write-two-reconnect-replay",
  "write-two-artifact-post-cleanup",
  "write-two-absence",
  "write-cancel-fixture",
  "write-cancel-mcp-surface",
  "write-cancel-spawn",
  "write-cancel-dispatch",
  "write-cancel-live-provider",
  "write-cancel-reconnect",
  "write-cancel-spawn-replay",
  "write-cancel-request",
  "write-cancel-wait",
  "write-cancel-result",
  "write-cancel-runtime-cleanup",
  "write-cancel-production-cleanup",
  "write-cancel-session-absence",
  "write-cancel-cleanup-reconnect",
  "write-cancel-cleanup",
  "emergency-cleanup"
]);
export let qualificationStage = "startup";

export function enterQualificationStage(stage) {
  if (!QUALIFICATION_STAGES.has(stage)) throw new Error("Unknown qualification stage.");
  qualificationStage = stage;
}

export class QualificationError extends Error {
  constructor(code, stage = qualificationStage, diagnostic = null) {
    const normalized = Object.hasOwn(FIXED_ERRORS, code) ? code : "E_SCENARIO";
    super(FIXED_ERRORS[normalized]);
    this.name = "QualificationError";
    this.code = normalized;
    this.stage = QUALIFICATION_STAGES.has(stage) ? stage : "startup";
    this.diagnostic = normalized === "E_CLEANUP" && diagnostic
      ? Object.freeze({ ...diagnostic })
      : null;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export function fail(code) {
  throw new QualificationError(code);
}

export function failSetupScan(code) {
  const setupScanCode = boundedSetupScanDiagnosticCode(code);
  if (!setupScanCode) fail("E_CLEANUP");
  throw new QualificationError(
    "E_CLEANUP",
    qualificationStage,
    { setupScanCode }
  );
}

export function checkInterrupted(state) {
  if (state.interrupted) fail("E_INTERRUPTED");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const key of Object.keys(value).sort()) next[key] = canonicalJson(value[key]);
  return next;
}

export function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export function canonicalDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

export function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

export function boundedString(value, maximum, { nonempty = false } = {}) {
  return typeof value === "string"
    && value.length <= maximum
    && Buffer.byteLength(value, "utf8") <= maximum * 4
    && (!nonempty || value.length > 0);
}

export function validStringList(value, {
  maximumItems = 200,
  maximumLength = 2000
} = {}) {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => boundedString(item, maximumLength));
}

export function safeParseJson(text, code) {
  if (
    typeof text !== "string"
    || Buffer.byteLength(text, "utf8") > MAX_COMMAND_OUTPUT_BYTES
  ) {
    fail(code);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

export function runBounded(command, args, {
  cwd = ROOT,
  env = process.env,
  timeoutMs = 60_000,
  requireSilentStderr = true,
  code = "E_SCENARIO"
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES
  });
  if (
    result.error
    || result.status !== 0
    || result.signal
    || (requireSilentStderr && String(result.stderr || "").trim() !== "")
    || Buffer.byteLength(String(result.stdout || ""), "utf8") > MAX_COMMAND_OUTPUT_BYTES
    || Buffer.byteLength(String(result.stderr || ""), "utf8") > MAX_COMMAND_OUTPUT_BYTES
  ) {
    fail(code);
  }
  return result;
}

export function runJson(command, args, options) {
  const result = runBounded(command, args, options);
  return safeParseJson(String(result.stdout || ""), options?.code || "E_SCENARIO");
}
