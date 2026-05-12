#!/usr/bin/env python3
"""ProbeStream data logger minimal starting point.

Connects to a running OpenOCD instance (or spawns one), discovers the
ProbeStream control block in the target's RAM, then polls all up-channels
and prints every byte received to stdout.  Optionally writes a timestamped
log file as well.

Edit the USER CONFIGURATION section below to match your setup, then run:

    python3 probestream_logger.py

Requirements: Python 3.10+, an OpenOCD instance reachable at TCL_HOST:TCL_PORT
(or set SPAWN_OPENOCD = True to have this script start one).
"""

import signal
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# USER CONFIGURATION edit these to match your setup
# ---------------------------------------------------------------------------


# Set to True to spawn OpenOCD from this script instead of connecting to one
# that's already running.
SPAWN_OPENOCD: bool = False

# Host / port of the OpenOCD TCL RPC interface.
TCL_HOST: str = "localhost"
TCL_PORT: int = 6666


# Path to the openocd binary.  "openocd" assumes it's on your PATH.
OPENOCD_PATH: str = "openocd"

# Path to the OpenOCD scripts directory (the -s flag).  Leave empty to rely
# on OpenOCD's built-in default search path.
OPENOCD_SCRIPTS_PATH: str = ""

# Interface config file.  Bare filenames like "stlink.cfg" are looked up
# under the "interface/" subdirectory of the OpenOCD scripts directory.
# Use a full path for custom configs.
INTERFACE_CONFIG: str = "interface/stlink.cfg"

# Target config file.  Examples: "target/stm32g4x.cfg", "target/stm32u5x.cfg"
TARGET_CONFIG: str = "target/stm32g4x.cfg"

# Adapter serial number leave empty to connect to the first probe found.
ADAPTER_SERIAL: str = ""

# Seconds to wait after spawning OpenOCD before connecting.
OPENOCD_STARTUP_DELAY: float = 1.5


# Start address of the target's RAM (used for control-block discovery scan).
RAM_START: int = 0x20000000

# How many bytes to scan for the ProbeStream magic.  Covers the whole RAM on
# most STM32 parts; reduce if discovery is slow.
RAM_SIZE: int = 192 * 1024  # 192 KB

# If you know the exact address of the ProbeStream control block (e.g. from
# your linker map or a fixed symbol), set it here and set ATTACH_ADDR_KNOWN
# to True to skip the scan.
ATTACH_ADDR_KNOWN: bool = False
CONTROL_BLOCK_ADDR: int = 0x20000000


# "auto"  try bulk read_memory first, fall back to per-word mdw.
#           Best choice for most setups; handles both ST-Link HLA and native.
# "bulk"  always use OpenOCD's read_memory command (fastest, requires
#           native DAP driver not HLA/ST-Link on U3).
# "mdw"   always use word-by-word mdw reads (slower but universally
#           supported, including HLA targets like STM32U3 over ST-Link V3).
READ_MODE: str = "auto"


# Seconds between poll_up calls.  Lower = less latency, more SWD traffic.
POLL_INTERVAL: float = 0.01  # 10 ms


# Print channel data to stdout as UTF-8 text (invalid bytes replaced).
PRINT_TO_STDOUT: bool = True

# Prefix each line printed to stdout with the channel index, e.g. "[ch0] ".
PRINT_CHANNEL_PREFIX: bool = True

# Write a log file alongside this script.  Set to "" or None to disable.
LOG_FILE: str = "probestream.log"

# ---------------------------------------------------------------------------
# END OF USER CONFIGURATION
# ---------------------------------------------------------------------------


# Locate the sidecar package next to this script's parent (tools/tui/sidecar).
_SIDECAR_DIR = Path(__file__).resolve().parent.parent / "tui" / "sidecar"
sys.path.insert(0, str(_SIDECAR_DIR))

from openocd_tcl import OpenOcdTcl, OpenOcdProcess  # noqa: E402
from probestream_reader import ProbeStreamReader     # noqa: E402


def _quiesce(tcl: OpenOcdTcl) -> None:
    """Turn off OpenOCD's background target-poll to avoid SWD contention."""
    try:
        tcl.send("poll off")
    except Exception as e:
        print(f"[logger] warning: could not disable OpenOCD poll: {e}", file=sys.stderr)


def _on_data(channel: int, data: bytes, log_fh) -> None:
    text = data.decode("utf-8", errors="replace")
    if PRINT_TO_STDOUT:
        prefix = f"[ch{channel}] " if PRINT_CHANNEL_PREFIX else ""
        # Data may contain embedded newlines; prefix every line.
        lines = text.splitlines(keepends=True)
        for line in lines:
            sys.stdout.write(prefix + line)
        sys.stdout.flush()
    if log_fh is not None:
        log_fh.write(text)
        log_fh.flush()


def main() -> None:
    ocd_proc = OpenOcdProcess()
    tcl = OpenOcdTcl(host=TCL_HOST, port=TCL_PORT)

    if SPAWN_OPENOCD:
        print(f"[logger] spawning OpenOCD ({OPENOCD_PATH}) …", flush=True)
        ocd_proc.spawn(
            openocd_path=OPENOCD_PATH,
            scripts_path=OPENOCD_SCRIPTS_PATH,
            interface_config=INTERFACE_CONFIG,
            target_config=TARGET_CONFIG,
            adapter_serial=ADAPTER_SERIAL,
            tcl_port=TCL_PORT,
        )
        time.sleep(OPENOCD_STARTUP_DELAY)
    else:
        print(f"[logger] connecting to OpenOCD at {TCL_HOST}:{TCL_PORT} …", flush=True)

    try:
        tcl.connect()
    except ConnectionRefusedError:
        print(
            f"[logger] error: could not connect to OpenOCD at {TCL_HOST}:{TCL_PORT}.\n"
            "  Make sure OpenOCD is running and its TCL port is open, or set\n"
            "  SPAWN_OPENOCD = True to have this script start it.",
            file=sys.stderr,
        )
        sys.exit(1)

    print("[logger] connected.", flush=True)
    _quiesce(tcl)

    reader = ProbeStreamReader(tcl, read_mode=READ_MODE)

    if ATTACH_ADDR_KNOWN:
        print(f"[logger] attaching to control block at 0x{CONTROL_BLOCK_ADDR:08X} …", flush=True)
        ok = reader.attach(CONTROL_BLOCK_ADDR)
    else:
        print(
            f"[logger] scanning 0x{RAM_START:08X}+{RAM_SIZE // 1024}KB for ProbeStream magic …",
            flush=True,
        )
        ok = reader.discover(RAM_START, RAM_SIZE)

    if not ok:
        print(
            "[logger] error: ProbeStream control block not found.\n"
            "  Check that the firmware has called PS_Init() and that RAM_START / RAM_SIZE\n"
            "  cover the buffer you passed to PS_Init().",
            file=sys.stderr,
        )
        tcl.close()
        if ocd_proc.running:
            ocd_proc.stop()
        sys.exit(1)

    print(
        f"[logger] attached at 0x{reader.cb_addr:08X} "
        f"{reader.num_up} up-channel(s), {reader.num_down} down-channel(s).",
        flush=True,
    )

    log_fh = None
    if LOG_FILE:
        log_path = Path(LOG_FILE)
        log_fh = log_path.open("a", encoding="utf-8")
        print(f"[logger] logging to {log_path.resolve()}", flush=True)

    running = True

    def _stop(sig, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    print("[logger] polling press Ctrl-C to stop.\n", flush=True)

    try:
        while running:
            try:
                reader.poll_up(lambda ch, data: _on_data(ch, data, log_fh))
            except Exception as e:
                print(f"[logger] poll error: {e}", file=sys.stderr, flush=True)
            time.sleep(POLL_INTERVAL)
    finally:
        if log_fh is not None:
            log_fh.close()
        tcl.close()
        if ocd_proc.running:
            ocd_proc.stop()
        print("\n[logger] stopped.", flush=True)


if __name__ == "__main__":
    main()
