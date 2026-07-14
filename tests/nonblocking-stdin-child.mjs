import process from "node:process";
import { pathToFileURL } from "node:url";

const [target, ...args] = process.argv.slice(2);
if (!target) {
  process.stderr.write("nonblocking-stdin-child requires a target module.\n");
  process.exit(2);
}

// Codex unified exec allocates a nonblocking PTY before write_stdin supplies
// command input. A normal child_process pipe is blocking, so force the same fd
// property before importing the real CLI entry point.
const setBlocking = process.stdin?._handle?.setBlocking;
if (typeof setBlocking !== "function") {
  process.stderr.write("nonblocking-stdin-child cannot configure fd 0 on this platform.\n");
  process.exit(77);
}
setBlocking.call(process.stdin._handle, false);

process.argv = [process.execPath, target, ...args];
await import(pathToFileURL(target).href);
