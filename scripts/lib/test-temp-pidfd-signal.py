#!/usr/bin/env python3

import os
import signal
import sys


def process_identity(pid):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
            stat = handle.read()
    except (FileNotFoundError, ProcessLookupError):
        return None
    command_end = stat.rfind(")")
    if command_end < 0:
        return None
    fields = stat[command_end + 1 :].strip().split()
    if len(fields) <= 19 or fields[0] in {"Z", "X", "x"}:
        return None
    start_time = fields[19]
    if not start_time.isdigit():
        return None
    return f"{pid}:{start_time}"


def main():
    if len(sys.argv) != 3:
        return 4
    expected = sys.argv[1]
    signal_name = sys.argv[2]
    try:
        pid_text, _ = expected.split(":", 1)
        pid = int(pid_text)
        selected_signal = getattr(signal, signal_name)
    except (AttributeError, TypeError, ValueError):
        return 4
    if pid <= 1:
        return 4

    try:
        descriptor = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return 3
    except (AttributeError, OSError):
        return 4
    try:
        if process_identity(pid) != expected:
            return 3
        try:
            signal.pidfd_send_signal(descriptor, selected_signal, None, 0)
        except ProcessLookupError:
            return 3
        except (AttributeError, OSError):
            return 4
        return 0
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    raise SystemExit(main())
