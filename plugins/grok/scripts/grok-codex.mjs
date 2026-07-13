#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";

process.env.GROK_COMPANION_HOST ||= process.env.CODEX_THREAD_ID
  ? "codex"
  : process.env.GROK_COMPANION_CLAUDE_SESSION_ID || process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PROJECT_DIR
    ? "claude-code"
    : "codex";
process.env.GROK_COMPANION_HOST_SESSION_ID ||= process.env.CODEX_THREAD_ID
  || process.env.GROK_COMPANION_CLAUDE_SESSION_ID
  || "";
process.env.GROK_COMPANION_PLUGIN_DATA ||= process.env.PLUGIN_DATA
  || process.env.CLAUDE_PLUGIN_DATA
  || path.join(process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex"), "plugins", "data", "grok-grok-companion");

await import("./grok-companion.mjs");
