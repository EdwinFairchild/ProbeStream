#!/usr/bin/env python3
"""
ProbeStream G4 end-to-end streaming test harness.

Builds the stress firmware, flashes it to the Nucleo-G474RE, then runs a
long-duration mode-5 stream (realistic periodic telemetry ~5 KB/s) directly
through the same OpenOcdTcl + ProbeStreamReader stack that the sidecar uses.

No TUI required.  Run from any directory:

    python3 tests/smoke_nucleo_g474/stream_test.py [options]

Options:
    --duration N        Stream for N seconds (default 120)
    --mode N            Firmware test mode (default 5)
    --skip-flash        Skip build + flash (use whatever is already on the board)
    --skip-build        Flash existing build, skip CMake/make
    --openocd-bin PATH  Override OpenOCD binary path
    --debug             Verbose logging
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[2]
G4_DIR    = Path(__file__).resolve().parent
BUILD_DIR = G4_DIR / "build_stress"
SIDECAR_DIR = REPO_ROOT / "tools" / "tui" / "sidecar"

sys.path.insert(0, str(SIDECAR_DIR))
from openocd_tcl import OpenOcdTcl
from probestream_reader import ProbeStreamReader

# ---------------------------------------------------------------------------
# Hardware constants (from benchmark_g4.py)
# ---------------------------------------------------------------------------
OPENOCD_BIN_DEFAULT = (
    "/opt/st/stm32cubeide_1.18.1/plugins/"
    "com.st.stm32cube.ide.mcu.externaltools.openocd.linux64_2.4.100.202501161620/"
    "tools/bin/openocd"
)
OPENOCD_SCRIPTS_DEFAULT = "/media/eddie/Engineering/Projects/ViewAlyzer_Root/external/OpenOCD/tcl"
OPENOCD_SCRIPTS_CANDIDATES = [
    REPO_ROOT.parent / "external" / "OpenOCD" / "tcl",
    Path(r"C:\opeonocd_12.0.3\share\openocd\scripts"),
    Path(r"C:\openocd\share\openocd\scripts"),
]
G4_STLINK_SN    = "0033004B3033510735393935"
TCL_PORT        = 6667   # use a separate port so we don't stomp a running dev session
RAM_START       = 0x20000000
RAM_SIZE        = 128 * 1024


# ---------------------------------------------------------------------------
# Build + flash
# ---------------------------------------------------------------------------

def build(skip_build: bool, debug: bool) -> Path:
    if skip_build:
        elf = next(BUILD_DIR.glob("*.elf"), None)
        if not elf:
            die("No .elf found in build_stress/ — run without --skip-build first")
        log(f"Using existing ELF: {elf}")
        return elf

    clean_stale_cmake_cache(BUILD_DIR)

    log("Configuring CMake (stress test)…")
    BUILD_DIR.mkdir(exist_ok=True)
    cmake_cmd = [
        "cmake", "-S", str(G4_DIR), "-B", str(BUILD_DIR), "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Debug",
        "-DSTRESS_TEST=ON",
    ]
    run(cmake_cmd, debug)

    log("Building…")
    run(["cmake", "--build", str(BUILD_DIR), "--", "-j4"], debug)

    elf = next(BUILD_DIR.glob("*.elf"), None)
    if not elf:
        die("Build succeeded but no .elf found — check CMake output")
    log(f"ELF: {elf}")
    return elf


def flash(elf: Path, ocd_bin: str, scripts_dir: Path, stlink_sn: str, debug: bool):
    log(f"Flashing {elf.name} via OpenOCD…")
    elf_tcl_path = elf.resolve().as_posix()
    cmd = [
        ocd_bin, "-s", str(scripts_dir),
        "-c", f"adapter serial {stlink_sn}",
        "-f", "interface/stlink.cfg",
        "-f", "target/stm32g4x.cfg",
        "-c", f"program {{{elf_tcl_path}}} verify reset exit",
    ]
    run(cmd, debug)
    log("Flash complete — board is running new firmware")
    time.sleep(0.3)   # let HAL_Init finish


# ---------------------------------------------------------------------------
# OpenOCD management
# ---------------------------------------------------------------------------

def start_openocd(ocd_bin: str, scripts_dir: Path, stlink_sn: str, debug: bool) -> subprocess.Popen:
    log(f"Starting OpenOCD (port {TCL_PORT})…")
    kwargs: dict = {
        "start_new_session": True,
    }
    if debug:
        kwargs["stdout"] = None   # inherit → visible in terminal
        kwargs["stderr"] = None
    else:
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL

    proc = subprocess.Popen(
        [
            ocd_bin, "-s", str(scripts_dir),
            "-c", f"adapter serial {stlink_sn}",
            "-f", "interface/stlink.cfg",
            "-f", "target/stm32g4x.cfg",
            "-c", f"tcl_port {TCL_PORT}",
        ],
        **kwargs,
    )
    # Wait for Tcl port to open.
    deadline = time.time() + 10.0
    import socket
    while time.time() < deadline:
        if proc.poll() is not None:
            die(f"OpenOCD exited immediately (code {proc.returncode})")
        try:
            s = socket.create_connection(("localhost", TCL_PORT), timeout=0.5)
            s.close()
            break
        except OSError:
            time.sleep(0.2)
    else:
        proc.terminate()
        die(f"OpenOCD Tcl port {TCL_PORT} never opened")
    log(f"OpenOCD ready (pid {proc.pid})")
    return proc


def stop_openocd(proc: subprocess.Popen):
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    log("OpenOCD stopped")


# ---------------------------------------------------------------------------
# Discover + quiesce
# ---------------------------------------------------------------------------

def discover_cb(tcl: OpenOcdTcl, debug: bool) -> int:
    log("Scanning RAM for ProbeStream control block…")
    reader = ProbeStreamReader(tcl, read_mode="auto")
    found = reader.discover(RAM_START, RAM_SIZE, scan_chunk_size=4096)
    if not found:
        die("Control block not found — is the stress firmware running?")
    log(f"Control block at 0x{reader.cb_addr:08X}  up={reader.num_up}  down={reader.num_down}")
    return reader


def quiesce(tcl: OpenOcdTcl):
    """Disable OpenOCD's background target polling so our reads don't race it."""
    try:
        tcl.send("poll off")
        log("OpenOCD background polling disabled (poll off)")
    except Exception as e:
        log(f"Warning: could not disable polling: {e}")


# ---------------------------------------------------------------------------
# Stream test
# ---------------------------------------------------------------------------

def send_mode_cmd(reader: ProbeStreamReader, mode: int):
    cmd = f"mode {mode}\n".encode()
    for _ in range(20):
        n = reader.write_down(0, cmd)
        if n == len(cmd):
            return
        time.sleep(0.05)
    log(f"Warning: could not write full mode command (sent {n}/{len(cmd)} bytes)")


def run_stream_test(
    reader: ProbeStreamReader,
    mode: int,
    duration: float,
    debug: bool,
):
    log(f"Starting mode-{mode} stream for {duration:.0f}s…")
    send_mode_cmd(reader, mode)
    time.sleep(0.1)

    # Drain any pre-existing boot message
    reader.poll_up()

    total_bytes   = 0
    total_batches = 0
    drop_events   = 0
    stall_events  = 0
    last_data_t   = time.time()
    last_report_t = time.time()
    start_t       = time.time()

    # Per-second rate sampling
    window_bytes = 0
    window_start = time.time()
    rates: list[float] = []

    STALL_THRESHOLD = 5.0    # seconds with no data → stall event
    REPORT_INTERVAL = 5.0    # print progress every N seconds

    consecutive_errors = 0

    while (time.time() - start_t) < duration:
        try:
            def on_data(_ch: int, data: bytes) -> None:
                nonlocal total_bytes, total_batches, window_bytes, last_data_t
                total_bytes   += len(data)
                total_batches += 1
                window_bytes  += len(data)
                last_data_t    = time.time()

            read = reader.poll_up(on_data)
            consecutive_errors = 0
        except Exception as e:
            consecutive_errors += 1
            drop_events += 1
            if consecutive_errors == 1 or (consecutive_errors & (consecutive_errors - 1)) == 0:
                log(f"  poll error #{consecutive_errors}: {type(e).__name__}: {e}")
                if consecutive_errors == 1:
                    traceback.print_exc()
            if consecutive_errors >= 5:
                time.sleep(0.5)
            read = 0

        now = time.time()

        # Rate sampling (1-second window)
        if now - window_start >= 1.0:
            rate = window_bytes / (now - window_start)
            rates.append(rate)
            window_bytes = 0
            window_start = now

        # Stall detection
        idle_secs = now - last_data_t
        if idle_secs >= STALL_THRESHOLD and total_bytes > 0:
            stall_events += 1
            log(
                f"  STALL detected — no data for {idle_secs:.1f}s  "
                f"(total {total_bytes} bytes, {total_batches} batches, "
                f"{stall_events} stalls so far)"
            )
            last_data_t = now   # reset so we only log once per stall

        # Progress report
        if now - last_report_t >= REPORT_INTERVAL:
            elapsed = now - start_t
            rate_now = rates[-1] if rates else 0.0
            avg_rate = (total_bytes / elapsed) if elapsed > 0 else 0.0
            log(
                f"  t={elapsed:5.0f}s  bytes={total_bytes:>8,}  "
                f"batches={total_batches:>5}  "
                f"rate={_fmt_rate(rate_now):>9}  avg={_fmt_rate(avg_rate):>9}  "
                f"stalls={stall_events}  errors={drop_events}"
            )
            last_report_t = now

        if read == 0:
            # Idle: back off a bit
            time.sleep(0.005)

    elapsed = time.time() - start_t
    avg_rate = total_bytes / elapsed if elapsed > 0 else 0.0
    min_rate = min(rates) if rates else 0.0
    max_rate = max(rates) if rates else 0.0

    print()
    print("=" * 60)
    print(f"  Duration:      {elapsed:.1f}s")
    print(f"  Total bytes:   {total_bytes:,}")
    print(f"  Total batches: {total_batches:,}")
    print(f"  Avg rate:      {_fmt_rate(avg_rate)}")
    print(f"  Rate range:    {_fmt_rate(min_rate)} – {_fmt_rate(max_rate)}")
    print(f"  Stall events:  {stall_events}")
    print(f"  Poll errors:   {drop_events}")
    verdict = "PASS" if stall_events == 0 and drop_events == 0 else "FAIL"
    print(f"  Verdict:       {verdict}")
    print("=" * 60)

    # Stop firmware
    send_mode_cmd(reader, 0)

    return verdict == "PASS"


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _fmt_rate(bps: float) -> str:
    if bps >= 1024:
        return f"{bps / 1024:.1f} KB/s"
    return f"{bps:.0f} B/s"


def log(msg: str):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def die(msg: str):
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd: list, debug: bool):
    if debug:
        log(f"  $ {' '.join(str(c) for c in cmd)}")
    result = subprocess.run(cmd, capture_output=not debug, text=True)
    if result.returncode != 0:
        if not debug and result.stderr:
            print(result.stderr, file=sys.stderr)
        die(f"Command failed (exit {result.returncode}): {cmd[0]}")


def clean_stale_cmake_cache(build_dir: Path):
    cache = build_dir / "CMakeCache.txt"
    files_dir = build_dir / "CMakeFiles"
    if not cache.exists():
        return

    text = cache.read_text(errors="ignore")
    stale_markers = ["/opt/st/", "/media/eddie/", "CMAKE_MAKE_PROGRAM:FILEPATH=/opt/"]
    stale = any(marker in text.replace("\\", "/") for marker in stale_markers)

    if not stale:
        for line in text.splitlines():
            if line.startswith("CMAKE_MAKE_PROGRAM:FILEPATH="):
                make_program = Path(line.split("=", 1)[1])
                stale = not make_program.exists()
                break

    if stale:
        log("Removing stale CMake cache before Windows reconfigure")
        cache.unlink(missing_ok=True)
        shutil.rmtree(files_dir, ignore_errors=True)


def resolve_openocd_bin(requested: str) -> str:
    if requested and Path(requested).exists():
        return requested
    fallback = shutil.which("openocd") or shutil.which("openocd.exe")
    if not fallback:
        die(f"OpenOCD binary not found at {requested} and not on PATH")
    log(f"OpenOCD not found at default path; using {fallback}")
    return fallback


def resolve_openocd_scripts(requested: str | None) -> Path:
    candidates = []
    if requested:
        candidates.append(Path(requested))
    candidates.append(Path(OPENOCD_SCRIPTS_DEFAULT))
    candidates.extend(OPENOCD_SCRIPTS_CANDIDATES)

    for candidate in candidates:
        if (candidate / "interface" / "stlink.cfg").exists() and (candidate / "target" / "stm32g4x.cfg").exists():
            return candidate
    checked = ", ".join(str(path) for path in candidates)
    die(f"OpenOCD scripts not found; checked: {checked}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="ProbeStream G4 streaming test")
    parser.add_argument("--duration",    type=float, default=120, metavar="S",
                        help="Stream duration in seconds (default 120)")
    parser.add_argument("--mode",        type=int,   default=5,
                        help="Firmware test mode (default 5 = realistic periodic)")
    parser.add_argument("--skip-flash",  action="store_true",
                        help="Skip build + flash; board must already have stress firmware")
    parser.add_argument("--skip-build",  action="store_true",
                        help="Skip CMake rebuild; flash existing build_stress/ ELF")
    parser.add_argument("--openocd-bin", default=OPENOCD_BIN_DEFAULT,
                        help="Path to OpenOCD binary")
    parser.add_argument("--openocd-scripts", default=None,
                        help="Path to OpenOCD scripts directory")
    parser.add_argument("--stlink-sn", default=G4_STLINK_SN,
                        help="ST-LINK serial number for the G4 board")
    parser.add_argument("--debug",       action="store_true",
                        help="Verbose output")
    args = parser.parse_args()

    print()
    print("=" * 60)
    print("  ProbeStream G4 streaming test harness")
    print(f"  mode={args.mode}  duration={args.duration}s")
    print("=" * 60)
    print()

    ocd_bin = resolve_openocd_bin(args.openocd_bin)
    scripts_dir = resolve_openocd_scripts(args.openocd_scripts)
    log(f"OpenOCD scripts: {scripts_dir}")
    log(f"ST-LINK serial: {args.stlink_sn}")

    # 1. Build + flash
    if not args.skip_flash:
        elf = build(skip_build=args.skip_build, debug=args.debug)
        flash(elf, ocd_bin, scripts_dir, args.stlink_sn, debug=args.debug)
        time.sleep(0.5)   # give firmware time to initialise after reset

    # 2. Start streaming OpenOCD
    ocd = start_openocd(ocd_bin, scripts_dir, args.stlink_sn, debug=args.debug)

    try:
        # 3. Connect Tcl
        tcl = OpenOcdTcl(host="localhost", port=TCL_PORT, timeout=10.0)
        tcl.connect()

        # 4. Quiesce — this is the key fix being tested
        quiesce(tcl)

        # 5. Discover control block
        reader = discover_cb(tcl, debug=args.debug)

        # 6. Drain any boot messages
        time.sleep(0.3)
        reader.poll_up()

        # 7. Run the stream test
        print()
        passed = run_stream_test(
            reader,
            mode=args.mode,
            duration=args.duration,
            debug=args.debug,
        )

        tcl.close()
        return 0 if passed else 1

    finally:
        stop_openocd(ocd)


if __name__ == "__main__":
    sys.exit(main())
