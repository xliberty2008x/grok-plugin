import { EventEmitter } from "node:events";
import { CompanionError } from "./errors.mjs";
import { redact } from "./redact.mjs";

export class AcpClient extends EventEmitter {
  constructor(child, { timeoutMs = 30000, knownSecrets = [], permissionPolicy = () => ({ outcome: { outcome: "cancelled" } }) } = {}) {
    super(); this.child = child; this.timeoutMs = timeoutMs; this.knownSecrets = knownSecrets; this.permissionPolicy = permissionPolicy; this.nextId = 1; this.pending = new Map(); this.buffer = ""; this.stderr = ""; this.closed = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#data(chunk));
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-32768); this.emit("stderr", redact(chunk, knownSecrets)); });
    child.on("exit", (code, signal) => this.#close(new CompanionError("E_PROVIDER_EXIT", `Grok ACP exited (${code ?? signal}).`, { code, signal, stderr: redact(this.stderr, knownSecrets) })));
    child.on("error", (error) => this.#close(new CompanionError("E_PROVIDER_EXIT", `Could not start Grok: ${error.message}`)));
  }
  #data(chunk) { this.buffer += chunk; if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024 && !this.buffer.includes("\n")) { this.#close(new CompanionError("E_PROTOCOL", "Grok ACP frame exceeded 8 MiB.")); try { this.child.kill("SIGTERM"); } catch {} return; } for (;;) { const end = this.buffer.indexOf("\n"); if (end < 0) break; const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch { this.#close(new CompanionError("E_PROTOCOL", "Grok emitted malformed ACP JSON.")); try { this.child.kill("SIGTERM"); } catch {} return; } this.#message(message); } }
  #message(message) {
    if (message.id != null && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CompanionError("E_PROTOCOL", message.error.message || "ACP request failed.", redact(message.error, this.knownSecrets)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      if (message.method === "session/request_permission") {
        let result;
        try { result = this.permissionPolicy(redact(message.params, this.knownSecrets)); }
        catch { result = { outcome: { outcome: "cancelled" } }; }
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        this.emit("permission", redact({ method: message.method, params: message.params, result }, this.knownSecrets));
      } else {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client method not supported." } })}\n`);
      }
      return;
    }
    if (message.method === "session/update") this.emit("update", normalizeUpdate(redact(message.params?.update, this.knownSecrets)));
    else this.emit("unknown", redact(message, this.knownSecrets));
  }
  #close(error) { if (this.closed) return; this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); this.emit("closed", error); }
  request(method, params = {}, timeoutMs = this.timeoutMs) { if (this.closed) return Promise.reject(new CompanionError("E_PROTOCOL", "ACP transport is closed.")); const id = this.nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new CompanionError("E_TIMEOUT", `${method} timed out.`)); }, timeoutMs); this.pending.set(String(id), { resolve, reject, timer }); this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }); }
  notify(method, params = {}) { if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
  close() { if (!this.closed) { this.child.stdin.end(); setTimeout(() => { if (!this.closed) this.child.kill("SIGTERM"); }, 500).unref(); } }
}

export function normalizeUpdate(update) {
  if (!update || typeof update !== "object") return { type: "unknown", value: update };
  const kind = update.sessionUpdate || update.type || "unknown";
  if (kind === "agent_message_chunk") return { type: "message", text: update.content?.text || "" };
  if (kind.includes("tool_call")) {
    const exitCode = [update.exitCode, update.exit_code, update.content?.exitCode, update.content?.exit_code]
      .find((value) => Number.isInteger(value));
    return {
      type: "tool",
      name: update.title || update.toolCallId || "tool",
      status: update.status || kind,
      ...(Number.isInteger(exitCode) ? { exitCode } : {})
    };
  }
  if (kind.includes("plan")) return { type: "plan", value: update };
  if (kind.includes("usage")) return { type: "usage", value: update };
  return { type: "unknown", value: update };
}
