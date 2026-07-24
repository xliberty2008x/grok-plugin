import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_RPC_ERROR_MESSAGE_BYTES = 64 * 1024;
const MAX_IN_FLIGHT_OPERATIONS = 32;
const MAX_QUEUED_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 16_384;
const MAX_JSON_ARRAY_LENGTH = 16_384;
const MAX_JSON_OBJECT_KEYS = 16_384;
const MAX_METHOD_BYTES = 1_024;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_ARG_COUNT = 256;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ARGV_BYTES = 1024 * 1024;
const MAX_ENV_KEYS = 512;
const MAX_ENV_ENTRY_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const EMPTY_BUFFER = Buffer.alloc(0);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const OPTION_KEYS = new Set([
  "executable",
  "argv",
  "cwd",
  "env",
  "rpcTimeoutMs",
  "shutdownTimeoutMs"
]);
const LIFECYCLE_METHODS = new Set([
  "initialize",
  "notifications/initialized"
]);

const ERROR_MESSAGES = Object.freeze({
  E_MCP_ARGUMENT: "MCP stdio client arguments are invalid.",
  E_MCP_CAPACITY: "MCP stdio client admission capacity is exhausted.",
  E_MCP_CLOSED: "MCP stdio client is closed.",
  E_MCP_DUPLICATE_RESPONSE: "MCP peer sent a duplicate response identifier.",
  E_MCP_FRAME_TOO_LARGE: "MCP peer exceeded the frame size limit.",
  E_MCP_ID_EXHAUSTED: "MCP request identifier space is exhausted.",
  E_MCP_INVALID_FRAME: "MCP peer sent an invalid JSON-RPC frame.",
  E_MCP_LIFECYCLE: "MCP protocol lifecycle transition is invalid.",
  E_MCP_MALFORMED_JSON: "MCP peer sent malformed JSON.",
  E_MCP_NEGOTIATION: "MCP initialize negotiation failed.",
  E_MCP_NOT_INITIALIZED: "MCP protocol initialization is required.",
  E_MCP_PROCESS_EXIT: "MCP child exited before the client was closed.",
  E_MCP_REMOTE_ERROR: "MCP peer returned a JSON-RPC error.",
  E_MCP_SERIALIZE: "MCP request could not be serialized safely.",
  E_MCP_SERVER_REQUEST: "MCP peer sent an unsupported server request.",
  E_MCP_SPAWN: "MCP child could not be started.",
  E_MCP_STDERR: "MCP child stderr could not be consumed.",
  E_MCP_STDIN: "MCP child stdin could not be written.",
  E_MCP_STDOUT: "MCP child stdout could not be consumed.",
  E_MCP_STDOUT_END: "MCP child stdout ended before the client was closed.",
  E_MCP_TERMINATION: "MCP child did not terminate within the bounded shutdown.",
  E_MCP_TIMEOUT: "MCP operation exceeded its bounded timeout.",
  E_MCP_UNKNOWN_RESPONSE: "MCP peer sent an unknown response identifier."
});

export class McpStdioClientError extends Error {
  constructor(code) {
    const normalizedCode = Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : "E_MCP_INVALID_FRAME";
    super(ERROR_MESSAGES[normalizedCode]);
    this.name = "McpStdioClientError";
    this.code = normalizedCode;
    this.stack = `${this.name}: ${this.message}`;
  }
}

function clientError(code) {
  return new McpStdioClientError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObjectOrArray(value) {
  return isRecord(value) || Array.isArray(value);
}

function isBoundedInteger(value, { minimum, maximum }) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validMethod(method) {
  return (
    typeof method === "string"
    && method.length > 0
    && method.length <= MAX_METHOD_BYTES
    && Buffer.byteLength(method, "utf8") <= MAX_METHOD_BYTES
    && !method.startsWith("rpc.")
  );
}

function validRpcId(id) {
  return (
    (Number.isSafeInteger(id) && id >= 0)
    || (typeof id === "string" && id.length > 0)
  );
}

function dataProperty(object, key, fallback) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, "value")) throw clientError("E_MCP_ARGUMENT");
  return descriptor.value;
}

function boundedString(value, maximumBytes) {
  return (
    typeof value === "string"
    && value.length <= maximumBytes
    && Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function cloneArgv(argv) {
  if (!Array.isArray(argv) || argv.length > MAX_ARG_COUNT) {
    throw clientError("E_MCP_ARGUMENT");
  }
  const clone = [];
  let totalBytes = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const value = dataProperty(argv, String(index));
    if (!boundedString(value, MAX_ARGUMENT_BYTES)) throw clientError("E_MCP_ARGUMENT");
    totalBytes += Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_ARGV_BYTES) throw clientError("E_MCP_ARGUMENT");
    clone.push(value);
  }
  return clone;
}

function cloneEnv(env) {
  if (!isRecord(env)) throw clientError("E_MCP_ARGUMENT");
  const prototype = Object.getPrototypeOf(env);
  if (prototype !== Object.prototype && prototype !== null) {
    throw clientError("E_MCP_ARGUMENT");
  }
  const clone = Object.create(null);
  let keys = 0;
  let totalBytes = 0;
  for (const key in env) {
    if (!Object.hasOwn(env, key)) throw clientError("E_MCP_ARGUMENT");
    keys += 1;
    if (keys > MAX_ENV_KEYS || !boundedString(key, MAX_ENV_ENTRY_BYTES)) {
      throw clientError("E_MCP_ARGUMENT");
    }
    const value = dataProperty(env, key);
    if (!boundedString(value, MAX_ENV_ENTRY_BYTES)) throw clientError("E_MCP_ARGUMENT");
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_ENV_BYTES) throw clientError("E_MCP_ARGUMENT");
    clone[key] = value;
  }
  return clone;
}

function validateOptions(options) {
  if (!isRecord(options)) throw clientError("E_MCP_ARGUMENT");
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw clientError("E_MCP_ARGUMENT");
  }
  let keys = 0;
  for (const key in options) {
    if (!Object.hasOwn(options, key) || !OPTION_KEYS.has(key)) {
      throw clientError("E_MCP_ARGUMENT");
    }
    keys += 1;
    if (keys > OPTION_KEYS.size) throw clientError("E_MCP_ARGUMENT");
    dataProperty(options, key);
  }
  const executable = dataProperty(options, "executable");
  const argv = dataProperty(options, "argv", []);
  const cwd = dataProperty(options, "cwd");
  const env = dataProperty(options, "env");
  const rpcTimeoutMs = dataProperty(options, "rpcTimeoutMs", DEFAULT_RPC_TIMEOUT_MS);
  const shutdownTimeoutMs = dataProperty(
    options,
    "shutdownTimeoutMs",
    DEFAULT_SHUTDOWN_TIMEOUT_MS
  );
  if (
    !boundedString(executable, MAX_PATH_BYTES)
    || executable.length === 0
    || !boundedString(cwd, MAX_PATH_BYTES)
    || cwd.length === 0
    || !isBoundedInteger(rpcTimeoutMs, { minimum: 1, maximum: 10 * 60_000 })
    || !isBoundedInteger(shutdownTimeoutMs, { minimum: 1, maximum: 60_000 })
  ) {
    throw clientError("E_MCP_ARGUMENT");
  }
  return {
    executable,
    argv: cloneArgv(argv),
    cwd,
    env: cloneEnv(env),
    rpcTimeoutMs,
    shutdownTimeoutMs
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function validRpcError(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length < 2
    || keys.length > 3
    || keys.some((key) => !["code", "message", "data"].includes(key))
    || !Object.hasOwn(value, "code")
    || !Object.hasOwn(value, "message")
    || !Number.isSafeInteger(value.code)
    || typeof value.message !== "string"
    || value.message.length > MAX_RPC_ERROR_MESSAGE_BYTES
  ) {
    return false;
  }
  return Buffer.byteLength(value.message, "utf8") <= MAX_RPC_ERROR_MESSAGE_BYTES;
}

function cloneJsonValue(value, budget, depth = 0) {
  if (depth > MAX_JSON_DEPTH || budget.nodes >= MAX_JSON_NODES) {
    throw clientError("E_MCP_ARGUMENT");
  }
  budget.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw clientError("E_MCP_ARGUMENT");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_FRAME_BYTES) throw clientError("E_MCP_FRAME_TOO_LARGE");
    const bytes = Buffer.byteLength(value, "utf8");
    budget.scalarBytes += bytes;
    if (budget.scalarBytes > MAX_FRAME_BYTES) throw clientError("E_MCP_FRAME_TOO_LARGE");
    return value;
  }
  if (typeof value !== "object" || value === null) {
    throw clientError("E_MCP_ARGUMENT");
  }

  if (budget.seen.has(value)) throw clientError("E_MCP_ARGUMENT");
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_ARRAY_LENGTH) throw clientError("E_MCP_ARGUMENT");
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) continue;
        if (!Object.hasOwn(descriptor, "value")) throw clientError("E_MCP_ARGUMENT");
        clone[index] = cloneJsonValue(descriptor.value, budget, depth + 1);
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw clientError("E_MCP_ARGUMENT");
    }
    const clone = Object.create(null);
    let keys = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) throw clientError("E_MCP_ARGUMENT");
      keys += 1;
      if (keys > MAX_JSON_OBJECT_KEYS || budget.nodes + keys > MAX_JSON_NODES) {
        throw clientError("E_MCP_ARGUMENT");
      }
      if (key.length > MAX_FRAME_BYTES) throw clientError("E_MCP_FRAME_TOO_LARGE");
      budget.scalarBytes += Buffer.byteLength(key, "utf8");
      if (budget.scalarBytes > MAX_FRAME_BYTES) throw clientError("E_MCP_FRAME_TOO_LARGE");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw clientError("E_MCP_ARGUMENT");
      }
      clone[key] = cloneJsonValue(descriptor.value, budget, depth + 1);
    }
    return clone;
  } finally {
    budget.seen.delete(value);
  }
}

function cloneParams(params, present) {
  if (!present) return undefined;
  if (!isObjectOrArray(params)) throw clientError("E_MCP_ARGUMENT");
  try {
    return cloneJsonValue(params, {
      nodes: 0,
      scalarBytes: 0,
      seen: new Set()
    });
  } catch (error) {
    if (error instanceof McpStdioClientError) throw error;
    throw clientError("E_MCP_ARGUMENT");
  }
}

function inboundJsonWithinLimits(text) {
  let depth = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;
  let inPrimitive = false;

  const admitToken = () => {
    tokens += 1;
    return tokens <= MAX_JSON_NODES;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
        if (!admitToken()) return false;
      }
      continue;
    }

    if (inPrimitive) {
      if (
        character !== ","
        && character !== "]"
        && character !== "}"
        && character !== " "
        && character !== "\t"
        && character !== "\r"
        && character !== "\n"
      ) {
        continue;
      }
      inPrimitive = false;
    }

    if (
      character === " "
      || character === "\t"
      || character === "\r"
      || character === "\n"
      || character === ","
      || character === ":"
    ) {
      continue;
    }
    if (character === "\"") {
      inString = true;
      escaped = false;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH || !admitToken()) return false;
      continue;
    }
    if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    inPrimitive = true;
    if (!admitToken()) return false;
  }
  return true;
}

function validInitializeResult(result, protocolVersion) {
  return (
    isRecord(result)
    && result.protocolVersion === protocolVersion
    && isRecord(result.serverInfo)
    && typeof result.serverInfo.name === "string"
    && result.serverInfo.name.length > 0
    && typeof result.serverInfo.version === "string"
    && result.serverInfo.version.length > 0
    && isRecord(result.capabilities)
    && (
      !Object.hasOwn(result, "instructions")
      || typeof result.instructions === "string"
    )
  );
}

class StderrCapture {
  #totalBytes = 0;
  #hash = createHash("sha256");
  #digest = null;

  update(chunk) {
    if (this.#digest !== null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#hash.update(bytes);
    this.#totalBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#totalBytes + bytes.length);
  }

  finalize() {
    if (this.#digest !== null) return;
    this.#digest = this.#hash.digest("hex");
    this.#hash = null;
  }

  summary() {
    return Object.freeze({
      bytes: this.#totalBytes,
      retainedBytes: 0,
      sha256: this.#digest ?? this.#hash.copy().digest("hex")
    });
  }
}

class McpStdioClient {
  #rpcTimeoutMs;
  #shutdownTimeoutMs;
  #transportState = "starting";
  #protocolState = "uninitialized";
  #failureCode = null;
  #nextRequestId = 1;
  #pending = new Map();
  #operations = new Set();
  #writeQueue = [];
  #activeWrite = null;
  #queuedPayloadBytes = 0;
  #stdoutAccumulator = null;
  #stdoutBytes = 0;
  #stdoutPeakBytes = 0;
  #stdoutDataEvents = 0;
  #stdoutAccumulatorAllocations = 0;
  #stderrCapture = new StderrCapture();
  #ready = deferred();
  #readyWaiters = 0;
  #initializeCloneCount = 0;
  #initializeClonesRetained = 0;
  #exited = deferred();
  #childExited = false;
  #closePromise = null;
  #listeners = [];
  #timers = new Set();
  #child;
  #handlesReleased = false;

  constructor(rawOptions) {
    const options = validateOptions(rawOptions);
    this.#rpcTimeoutMs = options.rpcTimeoutMs;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs;
    try {
      this.#child = spawn(options.executable, options.argv, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      this.#transportState = "failed";
      this.#failureCode = "E_MCP_SPAWN";
      throw clientError("E_MCP_SPAWN");
    }
    this.#attachTransportListeners();
    Object.preventExtensions(this);
  }

  #listen(target, event, listener) {
    target.on(event, listener);
    this.#listeners.push([target, event, listener]);
  }

  #attachTransportListeners() {
    this.#listen(this.#child, "spawn", () => {
      if (this.#transportState === "starting") {
        this.#transportState = "open";
        this.#ready.resolve();
      }
    });
    this.#attachChildLifecycleListeners();
    this.#listen(this.#child.stdout, "data", (chunk) => {
      if (this.#transportState !== "starting" && this.#transportState !== "open") return;
      this.#stdoutDataEvents = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#stdoutDataEvents + 1
      );
      this.#consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    this.#listen(this.#child.stdout, "end", () => {
      if (this.#transportState === "starting" || this.#transportState === "open") {
        this.#fail(clientError("E_MCP_STDOUT_END"));
      }
    });
    this.#listen(this.#child.stdout, "error", () => {
      if (this.#transportState === "starting" || this.#transportState === "open") {
        this.#fail(clientError("E_MCP_STDOUT"));
      }
    });
    this.#listen(this.#child.stderr, "data", (chunk) => {
      this.#stderrCapture.update(chunk);
    });
    this.#listen(this.#child.stderr, "error", () => {
      if (this.#transportState === "starting" || this.#transportState === "open") {
        this.#fail(clientError("E_MCP_STDERR"));
      }
    });
    this.#listen(this.#child.stdin, "error", () => {
      if (this.#transportState === "starting" || this.#transportState === "open") {
        this.#fail(clientError("E_MCP_STDIN"));
      }
    });
  }

  #attachChildLifecycleListeners() {
    const onError = () => {
      if (this.#childExited || this.#transportState === "closed") return;
      const code = this.#transportState === "starting" ? "E_MCP_SPAWN" : "E_MCP_PROCESS_EXIT";
      if (!Number.isInteger(this.#child.pid)) this.#markExited(null, null);
      this.#fail(clientError(code));
      if (this.#childExited) this.#releaseHandles();
    };
    const onExit = (code, signal) => {
      this.#markExited(code, signal);
      if (this.#transportState === "starting" || this.#transportState === "open") {
        this.#fail(clientError("E_MCP_PROCESS_EXIT"));
      }
      this.#releaseHandles();
    };
    this.#listen(this.#child, "error", onError);
    this.#listen(this.#child, "exit", onExit);
    this.#listen(this.#child, "close", onExit);
  }

  #setTimer(callback, timeoutMs) {
    let timer;
    timer = setTimeout(() => {
      this.#timers.delete(timer);
      callback();
    }, timeoutMs);
    this.#timers.add(timer);
    return timer;
  }

  #clearTimer(timer) {
    if (!timer) return;
    clearTimeout(timer);
    this.#timers.delete(timer);
  }

  #markExited(code, signal) {
    if (this.#childExited) return;
    this.#childExited = true;
    this.#exited.resolve(Object.freeze({
      code: Number.isInteger(code) ? code : null,
      signaled: typeof signal === "string"
    }));
  }

  #runWhenOpen(action) {
    if (this.#transportState === "open") {
      try {
        return action();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (this.#transportState === "starting") {
      this.#readyWaiters += 1;
      return this.#ready.promise.then(
        () => {
          this.#readyWaiters -= 1;
          if (this.#transportState !== "open") throw clientError("E_MCP_CLOSED");
          return action();
        },
        (error) => {
          this.#readyWaiters -= 1;
          throw error;
        }
      );
    }
    return Promise.reject(clientError("E_MCP_CLOSED"));
  }

  #appendStdoutBytes(segment) {
    if (segment.length > MAX_FRAME_BYTES - this.#stdoutBytes) {
      this.#wipeStdoutAccumulator();
      this.#fail(clientError("E_MCP_FRAME_TOO_LARGE"));
      return false;
    }
    if (segment.length > 0) {
      try {
        if (this.#stdoutAccumulator === null) {
          this.#stdoutAccumulator = Buffer.alloc(MAX_FRAME_BYTES);
          this.#stdoutAccumulatorAllocations += 1;
        }
        segment.copy(this.#stdoutAccumulator, this.#stdoutBytes);
      } catch {
        this.#wipeStdoutAccumulator();
        this.#fail(clientError("E_MCP_CAPACITY"));
        return false;
      }
      this.#stdoutBytes += segment.length;
      this.#stdoutPeakBytes = Math.max(this.#stdoutPeakBytes, this.#stdoutBytes);
    }
    return true;
  }

  #takeStdoutLine() {
    const line = this.#stdoutBytes === 0
      ? EMPTY_BUFFER
      : this.#stdoutAccumulator.subarray(0, this.#stdoutBytes);
    this.#stdoutBytes = 0;
    return line;
  }

  #wipeStdoutAccumulator() {
    if (this.#stdoutAccumulator !== null) {
      this.#stdoutAccumulator.fill(0);
      this.#stdoutAccumulator = null;
    }
    this.#stdoutBytes = 0;
  }

  #consumeStdout(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        this.#appendStdoutBytes(chunk.subarray(offset));
        return;
      }
      if (!this.#appendStdoutBytes(chunk.subarray(offset, newline))) return;
      const line = this.#takeStdoutLine();
      const frameBytes = line.length > 0 && line[line.length - 1] === 0x0d
        ? line.subarray(0, -1)
        : line;
      try {
        this.#consumeLine(frameBytes);
      } finally {
        line.fill(0);
      }
      if (this.#transportState !== "starting" && this.#transportState !== "open") return;
      offset = newline + 1;
    }
  }

  #consumeLine(line) {
    let text;
    try {
      text = UTF8_DECODER.decode(line);
    } catch {
      this.#fail(clientError("E_MCP_INVALID_FRAME"));
      return;
    }
    if (!inboundJsonWithinLimits(text)) {
      this.#fail(clientError("E_MCP_INVALID_FRAME"));
      return;
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.#fail(clientError("E_MCP_MALFORMED_JSON"));
      return;
    }
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
      this.#fail(clientError("E_MCP_INVALID_FRAME"));
      return;
    }

    const hasId = Object.hasOwn(frame, "id");
    const hasMethod = Object.hasOwn(frame, "method");
    if (hasMethod) {
      if (
        !validMethod(frame.method)
        || (
          Object.hasOwn(frame, "params")
          && !isObjectOrArray(frame.params)
        )
      ) {
        this.#fail(clientError("E_MCP_INVALID_FRAME"));
        return;
      }
      if (!hasId) {
        if (
          this.#protocolState === "uninitialized"
          || this.#protocolState === "initializing"
        ) {
          if (frame.method !== "notifications/message") {
            this.#fail(clientError("E_MCP_LIFECYCLE"));
          }
        }
        return;
      }
      if (!validRpcId(frame.id)) {
        this.#fail(clientError("E_MCP_INVALID_FRAME"));
        return;
      }
      if (frame.method !== "ping") {
        this.#fail(clientError("E_MCP_SERVER_REQUEST"));
        return;
      }
      this.#respondToPing(frame.id);
      return;
    }
    if (!hasId || !Number.isSafeInteger(frame.id) || frame.id < 1) {
      this.#fail(clientError("E_MCP_UNKNOWN_RESPONSE"));
      return;
    }

    const operation = this.#pending.get(frame.id);
    if (!operation) {
      const code = frame.id < this.#nextRequestId
        ? "E_MCP_DUPLICATE_RESPONSE"
        : "E_MCP_UNKNOWN_RESPONSE";
      this.#fail(clientError(code));
      return;
    }
    const hasResult = Object.hasOwn(frame, "result");
    const hasError = Object.hasOwn(frame, "error");
    if (
      hasResult === hasError
      || (hasError && !validRpcError(frame.error))
    ) {
      this.#fail(clientError("E_MCP_INVALID_FRAME"));
      return;
    }
    this.#pending.delete(frame.id);
    operation.responseDone = true;
    if (hasError) operation.responseErrorCode = "E_MCP_REMOTE_ERROR";
    else operation.result = frame.result;
    this.#finishRequestOperation(operation);
  }

  #serializeFrame(frame) {
    let serialized;
    try {
      serialized = JSON.stringify(frame);
    } catch {
      throw clientError("E_MCP_SERIALIZE");
    }
    if (typeof serialized !== "string") throw clientError("E_MCP_SERIALIZE");
    const payload = Buffer.from(`${serialized}\n`, "utf8");
    if (payload.length > MAX_FRAME_BYTES + 1) {
      payload.fill(0);
      throw clientError("E_MCP_FRAME_TOO_LARGE");
    }
    return payload;
  }

  #admitOperation({ payload, requestId = null, expectsResponse = false, priority = false }) {
    if (
      this.#operations.size >= MAX_IN_FLIGHT_OPERATIONS
      || this.#queuedPayloadBytes + payload.length > MAX_QUEUED_PAYLOAD_BYTES
    ) {
      payload.fill(0);
      throw clientError("E_MCP_CAPACITY");
    }
    const pending = deferred();
    const operation = {
      requestId,
      expectsResponse,
      settled: false,
      writeDone: false,
      responseDone: false,
      responseErrorCode: null,
      result: undefined,
      timer: null,
      promise: pending.promise,
      resolve: pending.resolve,
      reject: pending.reject
    };
    operation.timer = this.#setTimer(() => {
      if (operation.settled) return;
      // A timed-out stream is no longer safely correlated. Fail the whole
      // connection and force exact-child shutdown rather than reusing it.
      this.#fail(clientError("E_MCP_TIMEOUT"));
    }, this.#rpcTimeoutMs);
    this.#operations.add(operation);
    if (requestId !== null) this.#pending.set(requestId, operation);
    const write = { operation, payload, settled: false };
    this.#queuedPayloadBytes += payload.length;
    if (priority) this.#writeQueue.unshift(write);
    else this.#writeQueue.push(write);
    this.#pumpWrites();
    return operation;
  }

  #pumpWrites() {
    if (
      this.#activeWrite
      || this.#writeQueue.length === 0
      || this.#transportState !== "open"
    ) {
      return;
    }
    const write = this.#writeQueue.shift();
    this.#activeWrite = write;
    try {
      this.#child.stdin.write(write.payload, (error) => {
        this.#settleWrite(write, error ? clientError("E_MCP_STDIN") : null);
      });
    } catch {
      this.#settleWrite(write, clientError("E_MCP_STDIN"));
    }
  }

  #settleWrite(write, error) {
    if (write.settled) return;
    write.settled = true;
    if (this.#activeWrite === write) this.#activeWrite = null;
    else {
      const index = this.#writeQueue.indexOf(write);
      if (index !== -1) this.#writeQueue.splice(index, 1);
    }
    this.#queuedPayloadBytes = Math.max(0, this.#queuedPayloadBytes - write.payload.length);
    write.payload.fill(0);
    write.payload = EMPTY_BUFFER;
    if (error) {
      this.#fail(error);
      return;
    }
    const operation = write.operation;
    if (!operation.settled) {
      operation.writeDone = true;
      if (operation.expectsResponse) this.#finishRequestOperation(operation);
      else this.#completeOperation(operation, null, undefined);
    }
    this.#pumpWrites();
  }

  #finishRequestOperation(operation) {
    if (
      operation.settled
      || !operation.writeDone
      || !operation.responseDone
    ) {
      return;
    }
    const error = operation.responseErrorCode
      ? clientError(operation.responseErrorCode)
      : null;
    this.#completeOperation(operation, error, operation.result);
  }

  #completeOperation(operation, error, result) {
    if (operation.settled) return;
    operation.settled = true;
    this.#clearTimer(operation.timer);
    this.#operations.delete(operation);
    if (operation.requestId !== null) this.#pending.delete(operation.requestId);
    operation.result = undefined;
    const resolve = operation.resolve;
    const reject = operation.reject;
    operation.resolve = null;
    operation.reject = null;
    if (error) reject(error);
    else resolve(result);
  }

  #rejectOperations(error) {
    for (const operation of [...this.#operations]) {
      this.#completeOperation(operation, error, undefined);
    }
    this.#pending.clear();
  }

  #rejectWrites() {
    const writes = [
      ...(this.#activeWrite ? [this.#activeWrite] : []),
      ...this.#writeQueue
    ];
    this.#activeWrite = null;
    this.#writeQueue = [];
    for (const write of writes) {
      if (write.settled) continue;
      write.settled = true;
      this.#queuedPayloadBytes = Math.max(0, this.#queuedPayloadBytes - write.payload.length);
      write.payload.fill(0);
      write.payload = EMPTY_BUFFER;
    }
    this.#queuedPayloadBytes = 0;
  }

  #startRequest(method, params, paramsPresent) {
    if (!Number.isSafeInteger(this.#nextRequestId)) {
      return Promise.reject(clientError("E_MCP_ID_EXHAUSTED"));
    }
    const id = this.#nextRequestId;
    const frame = { jsonrpc: "2.0", id, method };
    if (paramsPresent) frame.params = params;
    let payload;
    try {
      payload = this.#serializeFrame(frame);
      const operation = this.#admitOperation({
        payload,
        requestId: id,
        expectsResponse: true
      });
      this.#nextRequestId += 1;
      return operation.promise;
    } catch (error) {
      if (payload) payload.fill(0);
      return Promise.reject(error);
    }
  }

  #startNotification(method, params, paramsPresent, { priority = false } = {}) {
    const frame = { jsonrpc: "2.0", method };
    if (paramsPresent) frame.params = params;
    let payload;
    try {
      payload = this.#serializeFrame(frame);
      return this.#admitOperation({ payload, priority }).promise;
    } catch (error) {
      if (payload) payload.fill(0);
      return Promise.reject(error);
    }
  }

  #respondToPing(id) {
    let payload;
    try {
      payload = this.#serializeFrame({ jsonrpc: "2.0", id, result: {} });
      const operation = this.#admitOperation({ payload, priority: true });
      operation.promise.catch(() => {});
    } catch (error) {
      if (payload) payload.fill(0);
      this.#fail(error);
    }
  }

  request(method, params) {
    if (this.#protocolState !== "initialized") {
      return Promise.reject(clientError("E_MCP_NOT_INITIALIZED"));
    }
    const paramsPresent = arguments.length >= 2;
    let cloned;
    try {
      if (!validMethod(method) || LIFECYCLE_METHODS.has(method)) {
        throw clientError("E_MCP_ARGUMENT");
      }
      cloned = cloneParams(params, paramsPresent);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#runWhenOpen(() => {
      if (this.#protocolState !== "initialized") {
        throw clientError("E_MCP_NOT_INITIALIZED");
      }
      return this.#startRequest(method, cloned, paramsPresent);
    });
  }

  notify(method, params) {
    if (this.#protocolState !== "initialized") {
      return Promise.reject(clientError("E_MCP_NOT_INITIALIZED"));
    }
    const paramsPresent = arguments.length >= 2;
    let cloned;
    try {
      if (!validMethod(method) || LIFECYCLE_METHODS.has(method)) {
        throw clientError("E_MCP_ARGUMENT");
      }
      cloned = cloneParams(params, paramsPresent);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#runWhenOpen(() => {
      if (this.#protocolState !== "initialized") {
        throw clientError("E_MCP_NOT_INITIALIZED");
      }
      return this.#startNotification(method, cloned, paramsPresent);
    });
  }

  initialize(options = {}, validateServer) {
    if (this.#protocolState !== "uninitialized") {
      return Promise.reject(clientError("E_MCP_LIFECYCLE"));
    }
    if (
      this.#transportState !== "starting"
      && this.#transportState !== "open"
    ) {
      return Promise.reject(clientError("E_MCP_CLOSED"));
    }
    // Claim the single initialization slot before inspecting caller-owned
    // values or attaching the sole permitted transport-ready continuation.
    this.#protocolState = "initializing";
    let params;
    let protocolVersion;
    try {
      if (!isRecord(options) || typeof validateServer !== "function") {
        throw clientError("E_MCP_ARGUMENT");
      }
      const requestedProtocol = dataProperty(options, "protocolVersion");
      const clientInfo = dataProperty(options, "clientInfo");
      const capabilities = dataProperty(options, "capabilities");
      const _meta = dataProperty(options, "_meta");
      if (
        typeof requestedProtocol !== "string"
        || requestedProtocol.length === 0
        || !isRecord(clientInfo)
        || !isRecord(capabilities)
        || (_meta !== undefined && !isRecord(_meta))
      ) {
        throw clientError("E_MCP_ARGUMENT");
      }
      protocolVersion = requestedProtocol;
      params = cloneParams({
        protocolVersion,
        clientInfo,
        capabilities,
        ...(_meta === undefined ? {} : { _meta })
      }, true);
      this.#initializeCloneCount += 1;
      this.#initializeClonesRetained = 1;
    } catch (error) {
      if (this.#protocolState === "initializing") {
        this.#protocolState = "uninitialized";
      }
      return Promise.reject(
        error instanceof McpStdioClientError
          ? error
          : clientError("E_MCP_ARGUMENT")
      );
    }

    const initialization = this.#runWhenOpen(() => {
      if (this.#protocolState !== "initializing") {
        throw clientError("E_MCP_LIFECYCLE");
      }
      const admittedParams = params;
      params = undefined;
      this.#initializeClonesRetained = 0;
      const negotiation = this.#startRequest("initialize", admittedParams, true).then((result) => {
        if (!validInitializeResult(result, protocolVersion)) {
          throw clientError("E_MCP_NEGOTIATION");
        }
        let accepted;
        try {
          accepted = validateServer(result);
        } catch {
          throw clientError("E_MCP_NEGOTIATION");
        }
        if (accepted !== true) throw clientError("E_MCP_NEGOTIATION");
        if (
          this.#transportState !== "open"
          || this.#protocolState !== "initializing"
        ) {
          throw clientError("E_MCP_CLOSED");
        }
        this.#protocolState = "acknowledging";
        return this.#startNotification("notifications/initialized", undefined, false)
          .then(() => {
            this.#protocolState = "initialized";
            return result;
          });
      });
      return negotiation.catch((error) => {
        if (
          this.#transportState === "open"
          && this.#protocolState !== "initialized"
        ) {
          this.#protocolState = "failed";
          this.#fail(
            error instanceof McpStdioClientError
              ? error
              : clientError("E_MCP_NEGOTIATION")
          );
        }
        if (this.#failureCode !== null) {
          throw clientError(this.#failureCode);
        }
        throw error;
      });
    });
    return initialization.finally(() => {
      params = undefined;
      this.#initializeClonesRetained = 0;
    });
  }

  ping() {
    return this.request("ping");
  }

  #fail(error) {
    if (
      this.#transportState === "failed"
      || this.#transportState === "closing"
      || this.#transportState === "closed"
      || this.#transportState === "shutdown_failed"
    ) {
      return;
    }
    this.#transportState = "failed";
    this.#protocolState = "failed";
    this.#failureCode = error.code;
    this.#ready.reject(error);
    this.#rejectOperations(error);
    this.#rejectWrites();
    this.#ensureShutdown(true);
  }

  #waitForExit(timeoutMs) {
    if (this.#childExited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.#setTimer(() => {
        settled = true;
        resolve(false);
      }, timeoutMs);
      this.#exited.promise.then(() => {
        if (settled) return;
        settled = true;
        this.#clearTimer(timer);
        resolve(true);
      });
    });
  }

  #endStdin() {
    try {
      this.#child.stdin.end();
    } catch {
      // Exact-PID termination follows a failed graceful close.
    }
  }

  #signal(signal) {
    if (
      this.#childExited
      || !Number.isInteger(this.#child.pid)
      || this.#child.pid <= 0
    ) {
      return;
    }
    try {
      this.#child.kill(signal);
    } catch {
      // The next bounded shutdown phase or retry handles signal failure.
    }
  }

  #releaseHandles() {
    if (this.#handlesReleased) return;
    this.#handlesReleased = true;
    this.#wipeStdoutAccumulator();
    this.#stderrCapture.finalize();
    for (const stream of [
      this.#child.stdin,
      this.#child.stdout,
      this.#child.stderr
    ]) {
      try {
        stream.destroy();
      } catch {
        // Transport release is best-effort after bounded shutdown.
      }
      try {
        stream.unref?.();
      } catch {
        // Platform stream implementations vary.
      }
    }
    try {
      this.#child.unref();
    } catch {
      // The exact child may already be closed.
    }
  }

  #removeListeners() {
    for (const [target, event, listener] of this.#listeners) {
      target.removeListener(event, listener);
    }
    this.#listeners = [];
  }

  #cleanupTransport() {
    this.#releaseHandles();
    this.#removeListeners();
    this.#wipeStdoutAccumulator();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #prepareShutdownRetry() {
    if (
      this.#child.exitCode !== null
      || this.#child.signalCode !== null
    ) {
      this.#markExited(this.#child.exitCode, this.#child.signalCode);
      return;
    }
    this.#exited = deferred();
    this.#attachChildLifecycleListeners();
  }

  async #performShutdown(force) {
    if (!this.#childExited && !force) {
      this.#endStdin();
      if (await this.#waitForExit(this.#shutdownTimeoutMs)) return;
    }
    if (!this.#childExited) {
      this.#signal("SIGTERM");
      if (await this.#waitForExit(this.#shutdownTimeoutMs)) return;
    }
    if (!this.#childExited) {
      this.#signal("SIGKILL");
      if (await this.#waitForExit(this.#shutdownTimeoutMs)) return;
    }
    if (!this.#childExited) throw clientError("E_MCP_TERMINATION");
  }

  #ensureShutdown(force) {
    if (this.#closePromise) return this.#closePromise;
    if (this.#transportState === "closed") {
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    if (this.#transportState === "shutdown_failed") {
      this.#prepareShutdownRetry();
    } else if (this.#transportState !== "failed") {
      this.#transportState = "closing";
    }
    if (
      this.#protocolState === "initializing"
      || this.#protocolState === "acknowledging"
    ) {
      this.#protocolState = "failed";
    }
    const closedError = clientError("E_MCP_CLOSED");
    this.#ready.reject(closedError);
    this.#rejectOperations(closedError);
    this.#rejectWrites();

    const attempt = this.#performShutdown(force).then(
      () => {
        this.#cleanupTransport();
        this.#transportState = "closed";
      },
      (error) => {
        this.#failureCode = error.code;
        this.#cleanupTransport();
        this.#transportState = "shutdown_failed";
        this.#closePromise = null;
        throw error;
      }
    );
    this.#closePromise = attempt;
    attempt.catch(() => {});
    return attempt;
  }

  close() {
    return this.#ensureShutdown(false);
  }

  terminate() {
    return this.#ensureShutdown(true);
  }

  diagnostics() {
    return Object.freeze({
      state: this.#transportState,
      protocolState: this.#protocolState,
      failureCode: this.#failureCode,
      childExited: this.#childExited,
      pendingRequests: this.#pending.size,
      activeOperations: this.#operations.size,
      activeWrites: this.#activeWrite ? 1 : 0,
      queuedWrites: this.#writeQueue.length,
      queuedPayloadBytes: this.#queuedPayloadBytes,
      readyWaiters: this.#readyWaiters,
      activeTimers: this.#timers.size,
      listenerCount: this.#listeners.length,
      handlesReleased: this.#handlesReleased,
      shutdownRetryable: this.#transportState === "shutdown_failed",
      initialization: Object.freeze({
        clonedPayloads: this.#initializeCloneCount,
        retainedClones: this.#initializeClonesRetained
      }),
      stdout: Object.freeze({
        accumulatorAllocations: this.#stdoutAccumulatorAllocations,
        accumulatorCapacityBytes: this.#stdoutAccumulator?.length ?? 0,
        bufferedBytes: this.#stdoutBytes,
        peakBufferedBytes: this.#stdoutPeakBytes,
        dataEvents: this.#stdoutDataEvents
      }),
      limits: Object.freeze({
        maxFrameBytes: MAX_FRAME_BYTES,
        maxInFlightOperations: MAX_IN_FLIGHT_OPERATIONS,
        maxInboundDepth: MAX_JSON_DEPTH,
        maxInboundTokens: MAX_JSON_NODES,
        maxQueuedPayloadBytes: MAX_QUEUED_PAYLOAD_BYTES
      }),
      stderr: this.#stderrCapture.summary()
    });
  }
}

export function spawnMcpStdioClient(options) {
  try {
    return new McpStdioClient(options);
  } catch (error) {
    if (error instanceof McpStdioClientError) throw error;
    throw clientError("E_MCP_ARGUMENT");
  }
}
