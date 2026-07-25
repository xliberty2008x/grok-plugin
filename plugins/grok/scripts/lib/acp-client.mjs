import { EventEmitter } from "node:events";
import { CompanionError } from "./errors.mjs";
import { redact } from "./redact.mjs";

const PROMPT_STOP_REASON_CLASSES = new Map([
  ["end_turn", "success"],
  ["max_tokens", "success"],
  ["max_turn_requests", "success"],
  ["cancelled", "cancelled"],
  ["refusal", "refusal"],
  // Older Grok builds used the ACP enum member names instead of their v1
  // wire values. Keep that compatibility explicit and classify it identically.
  ["EndTurn", "success"],
  ["MaxTokens", "success"],
  ["MaxTurnRequests", "success"],
  ["Cancelled", "cancelled"],
  ["Refusal", "refusal"]
]);

function exactMethodAllowlist(value) {
  if (value == null) return null;
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "requests")
    || !Object.hasOwn(value, "notifications")) {
    throw new CompanionError(
      "E_STATE",
      "ACP outbound allowlist must contain exact request and notification method lists."
    );
  }
  const normalize = (methods, label) => {
    if (!Array.isArray(methods)
      || methods.some((method) => typeof method !== "string" || !method)
      || new Set(methods).size !== methods.length) {
      throw new CompanionError(
        "E_STATE",
        `ACP outbound ${label} allowlist is malformed.`
      );
    }
    return new Set(methods);
  };
  return Object.freeze({
    requests: normalize(value.requests, "request"),
    notifications: normalize(value.notifications, "notification")
  });
}

/**
 * JSON-RPC ACP client with reserve-then-dispatch correlation.
 *
 * Delivered PromptResponse requires:
 * - jsonrpc === "2.0"
 * - exact numeric id matching the reserved request id (no string coercion)
 * - no method field
 * - exactly one valid result XOR error branch
 * - successful PromptResponse shape for session/prompt
 */
export class AcpClient extends EventEmitter {
  constructor(child, {
    timeoutMs = 30000,
    knownSecrets = [],
    permissionPolicy = () => ({ outcome: { outcome: "cancelled" } }),
    outboundAllowlist = null,
    cancelPermissions = false
  } = {}) {
    super();
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.knownSecrets = knownSecrets;
    this.permissionPolicy = permissionPolicy;
    this.outboundAllowlist = exactMethodAllowlist(outboundAllowlist);
    this.cancelPermissions = cancelPermissions === true;
    this.nextId = 1;
    this.reserved = new Set();
    this.used = new Set();
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
    this.transportError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#data(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32768);
      this.emit("stderr", redact(chunk, knownSecrets));
    });
    child.stdin.on("error", (error) => this.#close(new CompanionError(
      "E_PROTOCOL",
      `ACP stdin failed: ${error?.message || String(error)}.`,
      { code: error?.code || null }
    )));
    child.on("exit", (code, signal) => this.#close(new CompanionError(
      "E_PROVIDER_EXIT",
      `Grok ACP exited (${code ?? signal}).`,
      { code, signal, stderr: redact(this.stderr, knownSecrets) }
    )));
    child.on("error", (error) => this.#close(new CompanionError(
      "E_PROVIDER_EXIT",
      `Could not start Grok: ${error.message}`
    )));
  }

  /**
   * Reserve an exact numeric JSON-RPC request id without writing any bytes.
   * Callers must persist body-free inflight state before dispatchReserved.
   */
  reserveRequestId() {
    if (this.closed) {
      throw new CompanionError("E_PROTOCOL", "ACP transport is closed.");
    }
    const id = this.nextId;
    this.nextId += 1;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new CompanionError("E_PROTOCOL", "ACP request id space exhausted.");
    }
    this.reserved.add(id);
    return id;
  }

  /**
   * Dispatch one previously reserved request id. The id must not already be pending.
   */
  dispatchReserved(id, method, params = {}, timeoutMs = this.timeoutMs, {
    validateResult = null
  } = {}) {
    try {
      this.#assertOutboundMethod("requests", method);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.closed) {
      return Promise.reject(new CompanionError("E_PROTOCOL", "ACP transport is closed."));
    }
    if (!Number.isSafeInteger(id) || id < 1 || !this.reserved.has(id) || this.used.has(id)) {
      return Promise.reject(new CompanionError("E_PROTOCOL", "Reserved ACP request id is invalid."));
    }
    if (this.pending.has(id)) {
      return Promise.reject(new CompanionError("E_PROTOCOL", "Reserved ACP request id is already pending."));
    }
    this.reserved.delete(id);
    this.used.add(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(new CompanionError("E_TIMEOUT", `${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        validateResult: typeof validateResult === "function" ? validateResult : null,
        settled: false,
        responsePending: false
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        this.#close(new CompanionError(
          "E_PROTOCOL",
          `Failed to write ACP request: ${error?.message || String(error)}`
        ));
      }
    });
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    try {
      this.#assertOutboundMethod("requests", method);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.reserveRequestId();
    return this.dispatchReserved(id, method, params, timeoutMs);
  }

  /**
   * Reserve then dispatch session/prompt with strict PromptResponse validation.
   * Returns { id, result } on success. Failures never report delivered.
   */
  async promptTurn({ sessionId, prompt, timeoutMs = this.timeoutMs, reserveHook = null } = {}) {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new CompanionError("E_PROTOCOL", "session/prompt requires a session id.");
    }
    if (!Array.isArray(prompt)) {
      throw new CompanionError("E_PROTOCOL", "session/prompt requires a prompt array.");
    }
    const id = this.reserveRequestId();
    if (typeof reserveHook === "function") {
      await reserveHook(id);
    }
    const result = await this.dispatchReserved(
      id,
      "session/prompt",
      { sessionId, prompt },
      timeoutMs,
      { validateResult: validatePromptResponse }
    );
    return { id, result };
  }

  notify(method, params = {}) {
    this.#assertOutboundMethod("notifications", method);
    if (!this.closed) {
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      } catch (error) {
        this.#close(new CompanionError(
          "E_PROTOCOL",
          `Failed to write ACP notification: ${error?.message || String(error)}`
        ));
      }
    }
  }

  #assertOutboundMethod(kind, method) {
    if (typeof method !== "string" || !method) {
      throw new CompanionError("E_PROTOCOL", "ACP outbound method is invalid.");
    }
    const allowed = this.outboundAllowlist?.[kind] || null;
    if (allowed && !allowed.has(method)) {
      throw new CompanionError(
        "E_CAPABILITY",
        `ACP outbound ${kind === "requests" ? "request" : "notification"} method is not authorized.`
      );
    }
  }

  close() {
    if (!this.closed) {
      try {
        this.child.stdin.end();
      } catch (error) {
        this.#close(new CompanionError(
          "E_PROTOCOL",
          `Failed to close ACP stdin: ${error?.message || String(error)}`
        ));
        return;
      }
      setTimeout(() => {
        if (!this.closed) this.child.kill("SIGTERM");
      }, 500).unref();
    }
  }

  #data(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024 && !this.buffer.includes("\n")) {
      this.#close(new CompanionError("E_PROTOCOL", "Grok ACP frame exceeded 8 MiB."));
      try { this.child.kill("SIGTERM"); } catch { /* best-effort */ }
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#close(new CompanionError("E_PROTOCOL", "Grok emitted malformed ACP JSON."));
        try { this.child.kill("SIGTERM"); } catch { /* best-effort */ }
        return;
      }
      this.#message(message);
    }
  }

  #message(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#close(new CompanionError("E_PROTOCOL", "Grok emitted a non-object ACP frame."));
      return;
    }

    // Server requests (have method + id): never correlate as client responses.
    if (message.id != null && typeof message.method === "string") {
      if (message.jsonrpc !== "2.0") {
        this.#close(new CompanionError("E_PROTOCOL", "ACP server request jsonrpc version is invalid."));
        return;
      }
      if (message.method === "session/request_permission") {
        let result;
        if (this.cancelPermissions) {
          result = { outcome: { outcome: "cancelled" } };
        } else {
          try {
            result = this.permissionPolicy(redact(message.params, this.knownSecrets));
          } catch {
            result = { outcome: { outcome: "cancelled" } };
          }
        }
        try {
          this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        } catch (error) {
          this.#close(new CompanionError(
            "E_PROTOCOL",
            `Failed to write ACP permission response: ${error?.message || String(error)}`
          ));
          return;
        }
        this.emit("permission", redact({
          method: message.method,
          params: message.params,
          result
        }, this.knownSecrets));
      } else {
        try {
          this.child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Client method not supported." }
          })}\n`);
        } catch (error) {
          this.#close(new CompanionError(
            "E_PROTOCOL",
            `Failed to write ACP method response: ${error?.message || String(error)}`
          ));
        }
      }
      return;
    }

    // Notifications: id-less JSON-RPC method messages.
    // Emit one validated generic `notification` event, then preserve the
    // existing session/update → `update` and other-method → `unknown` paths.
    if (typeof message.method === "string") {
      if (!isValidJsonRpcNotification(message)) {
        this.#close(new CompanionError(
          "E_PROTOCOL",
          message.method === "session/update"
            ? "ACP session update envelope is invalid."
            : "ACP notification envelope is invalid."
        ));
        return;
      }
      const notification = redact(message, this.knownSecrets);
      this.emit("notification", notification);
      if (message.method === "session/update") {
        this.emit("update", normalizeUpdate(redact(message.params?.update, this.knownSecrets)));
        return;
      }
      this.emit("unknown", redact(message, this.knownSecrets));
      return;
    }

    // Client response correlation: exact numeric id only (no string coercion).
    if (!Object.hasOwn(message, "id") || !Number.isSafeInteger(message.id)) {
      if (typeof message.id === "string") {
        const colliding = Number(message.id);
        if (Number.isSafeInteger(colliding) && this.pending.has(colliding)) {
          this.#close(new CompanionError(
            "E_PROTOCOL",
            "ACP response used a string id that collides with a numeric request id."
          ));
        } else {
          // Servers must not answer client responses, but an unrelated
          // server-owned string-id response cannot settle a numeric request.
          this.emit("unknown", redact(message, this.knownSecrets));
        }
        return;
      }
      this.#close(new CompanionError("E_PROTOCOL", "ACP response id must be an exact numeric request id."));
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending || pending.settled || pending.responsePending) {
      this.#close(new CompanionError("E_PROTOCOL", "ACP response id is duplicate or unmatched."));
      return;
    }

    if (message.jsonrpc !== "2.0") {
      this.#rejectPending(message.id, new CompanionError(
        "E_PROTOCOL",
        "ACP response jsonrpc version is invalid."
      ));
      return;
    }
    if (Object.hasOwn(message, "method")) {
      this.#rejectPending(message.id, new CompanionError(
        "E_PROTOCOL",
        "ACP response must not include a method field."
      ));
      return;
    }

    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      this.#rejectPending(message.id, new CompanionError(
        "E_PROTOCOL",
        "ACP response must include exactly one of result or error."
      ));
      return;
    }
    const expectedKeys = hasResult
      ? new Set(["jsonrpc", "id", "result"])
      : new Set(["jsonrpc", "id", "error"]);
    if (Object.keys(message).length !== expectedKeys.size
      || Object.keys(message).some((key) => !expectedKeys.has(key))) {
      this.#rejectPending(message.id, new CompanionError(
        "E_PROTOCOL",
        "ACP response envelope contains unsupported fields."
      ));
      return;
    }

    if (hasError) {
      if (!message.error
        || typeof message.error !== "object"
        || Array.isArray(message.error)
        || !Number.isInteger(message.error.code)
        || typeof message.error.message !== "string"
        || !message.error.message) {
        this.#rejectPending(message.id, new CompanionError(
          "E_PROTOCOL",
          "ACP error response is malformed."
        ));
        return;
      }
      this.#rejectPending(message.id, new CompanionError(
        "E_PROTOCOL",
        message.error?.message || "ACP request failed.",
        redact(message.error, this.knownSecrets)
      ));
      return;
    }

    if (pending.validateResult) {
      try {
        pending.validateResult(message.result);
      } catch (error) {
        this.#rejectPending(
          message.id,
          error instanceof CompanionError
            ? error
            : new CompanionError("E_PROTOCOL", error?.message || "ACP result validation failed.")
        );
        return;
      }
    }

    // Do not publish a successful response until the complete stdout batch has
    // been parsed. A duplicate, colliding, or unmatched response later in the
    // same batch poisons the transport and must reject this request instead of
    // letting a mailbox persist a false delivered settlement.
    pending.responsePending = true;
    queueMicrotask(() => {
      const current = this.pending.get(message.id);
      if (!current || current.settled) return;
      if (this.closed || this.transportError) {
        this.#rejectPending(
          message.id,
          this.transportError || new CompanionError("E_PROTOCOL", "ACP transport closed before response settlement.")
        );
        return;
      }
      this.#resolvePending(message.id, message.result);
    });
  }

  #resolvePending(id, result) {
    const pending = this.pending.get(id);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  #rejectPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    this.transportError = error;
    for (const [id, pending] of this.pending.entries()) {
      if (pending.settled) continue;
      pending.settled = true;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.emit("closed", error);
  }
}

export function validatePromptResponse(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new CompanionError("E_PROTOCOL", "PromptResponse must be an object.");
  }
  if (typeof result.stopReason !== "string" || !result.stopReason) {
    throw new CompanionError("E_PROTOCOL", "PromptResponse.stopReason is required.");
  }
  if (!classifyPromptStopReason(result.stopReason).valid) {
    throw new CompanionError("E_PROTOCOL", "PromptResponse.stopReason is invalid.");
  }
  // Disallow embedding request-shaped fields.
  if (Object.hasOwn(result, "method") || Object.hasOwn(result, "jsonrpc")) {
    throw new CompanionError("E_PROTOCOL", "PromptResponse must not embed JSON-RPC envelope fields.");
  }
  return result;
}

export function isSuccessfulPromptStopReason(stopReason) {
  return classifyPromptStopReason(stopReason).successful;
}

export function isCancelledPromptStopReason(stopReason) {
  return classifyPromptStopReason(stopReason).cancelled;
}

export function classifyPromptStopReason(stopReason) {
  const classification = typeof stopReason === "string"
    ? PROMPT_STOP_REASON_CLASSES.get(stopReason) || null
    : null;
  return Object.freeze({
    valid: classification !== null,
    successful: classification === "success",
    cancelled: classification === "cancelled",
    refusal: classification === "refusal"
  });
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

/**
 * Strict JSON-RPC 2.0 notification envelope (id-less method message).
 * Allowed keys: jsonrpc, method, params. Rejects result/error/id and extras.
 */
export function isValidJsonRpcNotification(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  if (message.jsonrpc !== "2.0") return false;
  if (typeof message.method !== "string" || !message.method) return false;
  if (Object.hasOwn(message, "id")) return false;
  if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) return false;
  if (Object.hasOwn(message, "params")
    && (!message.params
      || typeof message.params !== "object")) {
    return false;
  }
  const keys = Object.keys(message);
  for (const key of keys) {
    if (key !== "jsonrpc" && key !== "method" && key !== "params") return false;
  }
  return true;
}
