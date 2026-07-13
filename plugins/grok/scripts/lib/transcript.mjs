import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionError } from "./errors.mjs";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_CONVERTED_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGES = 10_000;
const WIPE_CHUNK_BYTES = 64 * 1024;

function realDirectory(candidate) {
  try { return fs.realpathSync(candidate); } catch { return null; }
}

function beneath(file, root) {
  return Boolean(root && file !== root && file.startsWith(`${root}${path.sep}`));
}

function snapshot(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function matchesSnapshot(stat, expected) {
  return stat.isFile()
    && stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs;
}

export function openTranscriptSource(source, env = process.env) {
  let fd = null;
  try {
    if (fs.lstatSync(source).isSymbolicLink()) throw new CompanionError("E_IMPORT_SOURCE", "Transcript symlinks are not accepted.");
    const real = fs.realpathSync(source);
    const home = env.HOME || os.homedir();
    const claudeRoot = realDirectory(path.join(home, ".claude", "projects"));
    const codexHome = path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
    const codexRoot = realDirectory(path.join(codexHome, "sessions"));
    const format = beneath(real, claudeRoot) ? "claude-code" : beneath(real, codexRoot) ? "codex" : null;
    if (path.extname(real) !== ".jsonl" || !format) {
      throw new CompanionError("E_IMPORT_SOURCE", "Transcript must be a regular .jsonl file beneath ~/.claude/projects or the active Codex sessions directory.");
    }
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    const current = fs.statSync(real);
    const expected = snapshot(stat);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !matchesSnapshot(current, expected) || stat.size > MAX_SOURCE_BYTES) {
      throw new CompanionError("E_IMPORT_SOURCE", "Transcript changed while it was being opened or is not a regular .jsonl file of at most 100 MiB.");
    }
    return { real, fd, format, size: stat.size, snapshot: expected };
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_IMPORT_SOURCE", "Transcript must be a real .jsonl file beneath ~/.claude/projects or the active Codex sessions directory.");
  }
}

export function readTranscriptSnapshot(opened) {
  if (!opened || !Number.isInteger(opened.fd) || !Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > MAX_SOURCE_BYTES || opened.snapshot?.size !== opened.size) {
    throw new CompanionError("E_IMPORT_SOURCE", "Transcript snapshot metadata is invalid.");
  }
  try {
    const contents = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const count = fs.readSync(opened.fd, contents, offset, opened.size - offset, offset);
      if (count === 0) throw new CompanionError("E_IMPORT_SOURCE", "Transcript ended before its validated size could be read.");
      offset += count;
    }

    const afterRead = fs.fstatSync(opened.fd);
    if (!matchesSnapshot(afterRead, opened.snapshot)) {
      throw new CompanionError("E_IMPORT_SOURCE", "Transcript changed after it was opened; retry the transfer from a stable transcript.");
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(opened.fd, extra, 0, 1, opened.size) !== 0 || !matchesSnapshot(fs.fstatSync(opened.fd), opened.snapshot)) {
      throw new CompanionError("E_IMPORT_SOURCE", "Transcript grew after it was opened; retry the transfer from a stable transcript.");
    }
    return contents.toString("utf8");
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("E_IMPORT_SOURCE", "Transcript could not be read from its validated file descriptor.");
  }
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}

function writeConverted(lines, entry, state) {
  const encoded = `${JSON.stringify(entry)}\n`;
  state.bytes += Buffer.byteLength(encoded);
  state.messages += 1;
  if (state.bytes > MAX_CONVERTED_BYTES || state.messages > MAX_MESSAGES) {
    throw new CompanionError("E_IMPORT_SOURCE", "The converted Codex transcript exceeds the safe import limit.");
  }
  lines.push(encoded);
}

export function codexTranscriptToClaude(input, { cwd = process.cwd() } = {}) {
  const lines = [];
  const state = { bytes: 0, messages: 0 };
  let parentUuid = null;
  let sessionId = null;
  let sawCodexMetadata = false;
  let model = "codex";

  for (const raw of String(input).split(/\r?\n/)) {
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); }
    catch { throw new CompanionError("E_IMPORT_SOURCE", "Codex transcript contains malformed NDJSON."); }

    if (record?.type === "session_meta" && record.payload && typeof record.payload === "object") {
      sawCodexMetadata = true;
      sessionId = record.payload.id || record.payload.session_id || sessionId;
      continue;
    }
    if (record?.type === "turn_context" && typeof record.payload?.model === "string") {
      model = record.payload.model;
      continue;
    }
    if (record?.type !== "event_msg" || !record.payload) continue;

    const timestamp = validTimestamp(record.timestamp);
    if (record.payload.type === "user_message" && typeof record.payload.message === "string" && record.payload.message) {
      const uuid = crypto.randomUUID();
      writeConverted(lines, {
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId: sessionId || "codex-import",
        version: "2.1.0",
        gitBranch: null,
        type: "user",
        message: { role: "user", content: record.payload.message },
        uuid,
        timestamp
      }, state);
      parentUuid = uuid;
      continue;
    }

    if (record.payload.type === "agent_message" && typeof record.payload.message === "string" && record.payload.message) {
      const phase = record.payload.phase;
      if (phase && phase !== "commentary" && phase !== "final_answer") continue;
      const uuid = crypto.randomUUID();
      writeConverted(lines, {
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId: sessionId || "codex-import",
        version: "2.1.0",
        gitBranch: null,
        type: "assistant",
        message: {
          id: `msg_${uuid.replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: record.payload.message }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        },
        requestId: `req_${crypto.randomUUID().replaceAll("-", "")}`,
        uuid,
        timestamp
      }, state);
      parentUuid = uuid;
    }
  }

  if (!sawCodexMetadata || state.messages === 0) {
    throw new CompanionError("E_IMPORT_SOURCE", "The Codex transcript format is unsupported or contains no transferable user-visible messages.");
  }
  return lines.join("");
}

export function createAnonymousTranscript(contents, directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `converted-${crypto.randomBytes(12).toString("hex")}.jsonl`);
  const fd = fs.openSync(file, "wx+", 0o600);
  let anonymous = false;
  try {
    try {
      fs.unlinkSync(file);
      anonymous = true;
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    const buffer = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    fs.fsyncSync(fd);
    return { fd, file: anonymous ? null : file };
  } catch (error) {
    if (anonymous) try { fs.closeSync(fd); } catch {}
    else disposeConvertedTranscript({ fd, file });
    throw error;
  }
}

function wipeDescriptor(fd, stat) {
  if (!stat.isFile()) throw new Error("Converted transcript descriptor is not a regular file.");
  const zeros = Buffer.alloc(Math.min(WIPE_CHUNK_BYTES, Math.max(1, stat.size)));
  let offset = 0;
  while (offset < stat.size) {
    const length = Math.min(zeros.length, stat.size - offset);
    const written = fs.writeSync(fd, zeros, 0, length, offset);
    if (written <= 0) throw new Error("Could not overwrite the converted transcript.");
    offset += written;
  }
  fs.fsyncSync(fd);
  fs.ftruncateSync(fd, 0);
  fs.fsyncSync(fd);
}

export function disposeConvertedTranscript({ fd, file }) {
  const warnings = [];
  let expected = null;
  if (file) {
    try {
      const stat = fs.fstatSync(fd);
      expected = snapshot(stat);
      wipeDescriptor(fd, stat);
    }
    catch (error) { warnings.push(error.message); }
  }
  try { fs.closeSync(fd); }
  catch (error) { warnings.push(error.message); }
  if (file) {
    try {
      const current = fs.lstatSync(file);
      if (expected && (current.dev !== expected.dev || current.ino !== expected.ino)) {
        throw new Error("Refusing to unlink a replaced converted transcript path.");
      }
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push(error.message);
    }
  }
  return { ok: warnings.length === 0, warning: warnings.join("; ") || null };
}
