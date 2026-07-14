import process from "node:process";

import { CompanionError } from "./errors.mjs";

export const STDIN_READY_MARKER = "GROK_COMPANION_STDIN_READY";

/**
 * Read bounded command input through Node's stream layer.
 *
 * Codex unified exec exposes a PTY/nonblocking pipe before the host writes the
 * TaskEnvelope. Direct fs.readSync(0) therefore leaks EAGAIN. The stream layer
 * waits for readiness and preserves the start-process -> private frame contract.
 */
export function readBoundedStdin({
  stream = process.stdin,
  limitBytes = 256 * 1024,
  label = "Input",
  timeoutMs = 60_000,
  onReady = null
} = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    let rawModeEnabled = false;

    const restoreTty = () => {
      if (!rawModeEnabled) return;
      rawModeEnabled = false;
      try { stream.setRawMode(false); }
      catch { /* The command is exiting; do not replace the primary result. */ }
    };

    const cleanup = ({ pause = false } = {}) => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
      if (pause) {
        stream.pause?.();
        stream.unref?.();
      }
      restoreTty();
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup({ pause: true });
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup({ pause: true });
      reject(error);
    };
    const append = (buffer) => {
      total += buffer.byteLength;
      if (total > limitBytes) {
        fail(new CompanionError("E_USAGE", `${label} stdin exceeds the ${Math.ceil(limitBytes / 1024)} KiB input limit.`));
        return false;
      }
      chunks.push(Buffer.from(buffer));
      return true;
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      // Raw mode disables PTY echo and canonical buffering. Ctrl-D is then a
      // literal EOT byte, so treat it as the private JSON frame terminator.
      const interrupt = rawModeEnabled ? buffer.indexOf(0x03) : -1;
      const terminator = rawModeEnabled ? buffer.indexOf(0x04) : -1;
      if (interrupt !== -1 && (terminator === -1 || interrupt < terminator)) {
        fail(new CompanionError("E_CANCELLED", `${label} input was cancelled before dispatch.`));
        return;
      }
      if (terminator === -1) {
        append(buffer);
        return;
      }
      if (!append(buffer.subarray(0, terminator))) return;
      if (buffer.subarray(terminator + 1).some((byte) => ![9, 10, 13, 32].includes(byte))) {
        fail(new CompanionError("E_USAGE", `${label} stdin contains data after its EOT terminator.`));
        return;
      }
      succeed();
    };
    const onEnd = () => succeed();
    const onClose = () => {
      if (stream.readableEnded) succeed();
      else onError(new Error("stdin closed before EOF"));
    };
    const onError = (error) => fail(new CompanionError(
      "E_INPUT_READ",
      `${label} stdin could not be read.`,
      { systemCode: error?.code || null }
    ));
    timer = setTimeout(() => fail(new CompanionError(
      "E_INPUT_TIMEOUT",
      `${label} stdin was not received and terminated within ${Math.ceil(timeoutMs / 1000)} seconds.`
    )), timeoutMs);

    try {
      if (stream.isTTY && typeof stream.setRawMode === "function") {
        stream.setRawMode(true);
        rawModeEnabled = true;
      }
      stream.on("data", onData);
      stream.once("end", onEnd);
      stream.once("close", onClose);
      stream.once("error", onError);
      if (stream.errored) onError(stream.errored);
      else if (stream.readableEnded) succeed();
      else if (stream.destroyed) onClose();
      else {
        stream.resume?.();
        if (typeof onReady === "function") onReady();
      }
    } catch (error) {
      onError(error);
    }
  });
}
