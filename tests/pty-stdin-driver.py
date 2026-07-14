#!/usr/bin/env python3

import errno
import json
import os
import pty
import subprocess
import sys
import threading
import time


READY = b"GROK_COMPANION_STDIN_READY\n"


def read_all(stream, chunks, ready_event=None):
    read = getattr(stream, "read1", stream.read)
    while True:
        chunk = read(4096)
        if not chunk:
            return
        chunks.append(chunk)
        if ready_event is not None and READY in b"".join(chunks):
            ready_event.set()


def write_all(fd, payload):
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def drain_pty(fd):
    chunks = []
    os.set_blocking(fd, False)
    while True:
        try:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            chunks.append(chunk)
        except BlockingIOError:
            break
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
    return b"".join(chunks)


def provider_starts(path):
    if not path or not os.path.exists(path):
        return 0
    count = 0
    with open(path, "r", encoding="utf-8") as stream:
        for line in stream:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            args = entry.get("args", [])
            if entry.get("event") == "argv" and "agent" in args and "stdio" in args:
                count += 1
    return count


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: pty-stdin-driver.py <node> <target> [args...]")
    payload = sys.stdin.buffer.read()
    master, slave = pty.openpty()
    os.set_blocking(slave, False)
    child_env = os.environ.copy()
    observation_log = child_env.pop("GROK_TEST_PTY_OBSERVE_LOG", None)
    process = subprocess.Popen(
        sys.argv[1:],
        stdin=slave,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=os.getcwd(),
        env=child_env,
    )
    os.close(slave)

    stdout_chunks = []
    stderr_chunks = []
    ready_event = threading.Event()
    stdout_thread = threading.Thread(target=read_all, args=(process.stdout, stdout_chunks), daemon=True)
    stderr_thread = threading.Thread(target=read_all, args=(process.stderr, stderr_chunks, ready_event), daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    requires_ready = "--stdin-ready" in sys.argv[3:]
    if requires_ready:
        ready = ready_event.wait(timeout=5)
    else:
        # Reproduce issue #2's original host ordering: the process starts with
        # an empty nonblocking PTY and the host writes after a short yield even
        # when no explicit readiness marker was requested.
        # The issue reproduction used a one-second initial Codex yield before
        # writing to the returned session handle.
        time.sleep(1.0)
        ready = ready_event.is_set()
    alive_before_input = process.poll() is None
    starts_before_input = provider_starts(observation_log)
    write_error = None
    if (ready or not requires_ready) and alive_before_input:
        split = max(1, len(payload) // 2)
        try:
            write_all(master, payload[:split])
            time.sleep(0.025)
            write_all(master, payload[split:] + b"\n\x04")
        except OSError as error:
            write_error = f"{error.__class__.__name__}: {error}"

    try:
        code = process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        code = process.wait(timeout=5)
        write_error = write_error or "target timed out"

    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)
    pty_output = drain_pty(master)
    os.close(master)
    result = {
        "code": code,
        "ready": ready,
        "requiresReady": requires_ready,
        "aliveBeforeInput": alive_before_input,
        "providerStartsBeforeInput": starts_before_input,
        "stdout": b"".join(stdout_chunks).decode("utf-8", errors="replace"),
        "stderr": b"".join(stderr_chunks).decode("utf-8", errors="replace"),
        "ptyOutput": pty_output.decode("utf-8", errors="replace"),
        "writeError": write_error,
    }
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
