#!/usr/bin/env python3
"""
ProbeStream end-to-end streaming test harness (board-agnostic).

Builds the stress firmware for the selected board, flashes it via OpenOCD,
then runs a long-duration mode-5 stream (realistic periodic telemetry ~5 KB/s)
through the same OpenOcdTcl + ProbeStreamReader stack the sidecar uses.

Usage:
    python3 tests/stream_test.py --board g474 [options]
    python3 tests/stream_test.py --board u385 [options]

Options:
    --duration N        Stream for N seconds (default 120)
    --mode N            Firmware test mode (default 5)
    --skip-flash        Skip build + flash (use whatever is on the board)
    --skip-build        Flash existing build_stress/ ELF, skip CMake
    --openocd-bin PATH  Override OpenOCD binary path (else PROBESTREAM_OPENOCD_BIN / PATH)
    --openocd-scripts P Override OpenOCD scripts dir (else PROBESTREAM_OPENOCD_SCRIPTS)
    --stlink-sn SN      ST-LINK serial number (else PROBESTREAM_<BOARD>_STLINK_SN)
    --debug             Verbose logging
"""

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths / sys.path
# ---------------------------------------------------------------------------
REPO_ROOT   = Path(__file__).resolve().parents[1]
TESTS_DIR   = Path(__file__).resolve().parent
SIDECAR_DIR = REPO_ROOT / "tools" / "tui" / "sidecar"

sys.path.insert(0, str(SIDECAR_DIR))
sys.path.insert(0, str(TESTS_DIR))
from openocd_tcl import OpenOcdTcl
from probestream_reader import ProbeStreamReader
import load_env  # noqa: F401  (loads tests/.env if present)


# ---------------------------------------------------------------------------
# Per-board configuration
# ---------------------------------------------------------------------------
TCL_PORT  = 6667           # separate from a running dev session on 6666
RAM_START = 0x20000000

BOARDS: dict[str, dict] = {
    "g474": {
        "dir":          TESTS_DIR / "smoke_nucleo_g474",
        "ocd_target":   "target/stm32g4x.cfg",
        "ram_size":     128 * 1024,
        "stlink_env":   "PROBESTREAM_G4_STLINK_SN",
        "stlink_def":   "0033004B3033510735393935",
        "flash_method": "openocd",
    },
    "u385": {
        "dir":          TESTS_DIR / "smoke_nucleo_u385",
        "ocd_target":   "target/stm32u3x.cfg",
        "ram_size":     192 * 1024,
        "stlink_env":   "PROBESTREAM_U3_STLINK_SN",
        "stlink_def":   "",   # U3 board: no pinned serial by default
        # OpenOCD's U3 flash driver fails on dual-bank erase; use ST's CLI tool.
        "flash_method": "stm32_programmer",
    },
}


# ---------------------------------------------------------------------------
# Build + flash
# ---------------------------------------------------------------------------

def build(board_dir: Path, build_dir: Path, skip_build: bool, debug: bool) -> Path:
    if skip_build:
        elf = next(build_dir.glob("*.elf"), None)
        if not elf:
            die(f"No .elf found in {build_dir} — run without --skip-build first")
        log(f"Using existing ELF: {elf}")
        return elf

    clean_stale_cmake_cache(build_dir)

    log("Configuring CMake (stress test)…")
    build_dir.mkdir(exist_ok=True)
    run([
        "cmake", "-S", str(board_dir), "-B", str(build_dir), "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Debug",
        "-DSTRESS_TEST=ON",
    ], debug)

    log("Building…")
    run(["cmake", "--build", str(build_dir), "--", "-j4"], debug)

    elf = next(build_dir.glob("*.elf"), None)
    if not elf:
        die("Build succeeded but no .elf found — check CMake output")
    log(f"ELF: {elf}")
    return elf


def flash_openocd(elf: Path, ocd_bin: str, scripts_dir: Path, ocd_target: str,
                  stlink_sn: str, debug: bool):
    log(f"Flashing {elf.name} via OpenOCD…")
    elf_tcl_path = elf.resolve().as_posix()
    cmd = [ocd_bin, "-s", str(scripts_dir)]
    if stlink_sn:
        cmd += ["-c", f"adapter serial {stlink_sn}"]
    cmd += [
        "-f", "interface/stlink.cfg",
        "-f", ocd_target,
        "-c", f"program {{{elf_tcl_path}}} verify reset exit",
    ]
    run(cmd, debug)
    log("Flash complete — board is running new firmware")
    time.sleep(0.3)


def flash_stm32_programmer(elf: Path, stlink_sn: str, debug: bool):
    """Use STM32_Programmer_CLI — needed for U3 (OpenOCD's flash driver fails)."""
    prog = os.environ.get("PROBESTREAM_STM32_PROGRAMMER") or shutil.which("STM32_Programmer_CLI")
    if not prog or not Path(prog).exists():
        die("STM32_Programmer_CLI not found. Set PROBESTREAM_STM32_PROGRAMMER or put it on PATH.")

    hex_path = elf.with_suffix(".hex")
    log(f"Converting {elf.name} → {hex_path.name}…")
    objcopy = shutil.which("arm-none-eabi-objcopy")
    if not objcopy:
        die("arm-none-eabi-objcopy not found on PATH")
    run([objcopy, "-O", "ihex", str(elf), str(hex_path)], debug)

    log(f"Flashing {hex_path.name} via STM32_Programmer_CLI…")
    cmd = [prog, "-c", "port=SWD", "mode=UR"]
    if stlink_sn:
        cmd += [f"sn={stlink_sn}"]
    cmd += ["-e", "all", "-w", str(hex_path), "-v", "-rst"]
    run(cmd, debug)
    log("Flash complete — board is running new firmware")
    time.sleep(0.3)


def flash(method: str, elf: Path, ocd_bin: str, scripts_dir: Path, ocd_target: str,
          stlink_sn: str, debug: bool):
    if method == "stm32_programmer":
        flash_stm32_programmer(elf, stlink_sn, debug)
    else:
        flash_openocd(elf, ocd_bin, scripts_dir, ocd_target, stlink_sn, debug)


# ---------------------------------------------------------------------------
# OpenOCD management
# ---------------------------------------------------------------------------

def start_openocd(ocd_bin: str, scripts_dir: Path, ocd_target: str,
                  stlink_sn: str, debug: bool) -> subprocess.Popen:
    log(f"Starting OpenOCD (port {TCL_PORT})…")
    kwargs: dict = {"start_new_session": True}
    if debug:
        kwargs["stdout"] = None
        kwargs["stderr"] = None
    else:
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL

    cmd = [ocd_bin, "-s", str(scripts_dir)]
    if stlink_sn:
        cmd += ["-c", f"adapter serial {stlink_sn}"]
    cmd += [
        "-f", "interface/stlink.cfg",
        "-f", ocd_target,
        "-c", f"tcl_port {TCL_PORT}",
    ]

    proc = subprocess.Popen(cmd, **kwargs)
    deadline = time.time() + 10.0
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

def discover_cb(tcl: OpenOcdTcl, ram_size: int, debug: bool) -> ProbeStreamReader:
    log("Scanning RAM for ProbeStream control block…")
    reader = ProbeStreamReader(tcl, read_mode="auto")
    if not reader.discover(RAM_START, ram_size, scan_chunk_size=4096):
        die("Control block not found — is the stress firmware running?")
    log(f"Control block at 0x{reader.cb_addr:08X}  up={reader.num_up}  down={reader.num_down}")
    return reader


def quiesce(tcl: OpenOcdTcl):
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
    n = 0
    for _ in range(20):
        n = reader.write_down(0, cmd)
        if n == len(cmd):
            return
        time.sleep(0.05)
    log(f"Warning: could not write full mode command (sent {n}/{len(cmd)} bytes)")


def run_stream_test(reader: ProbeStreamReader, mode: int, duration: float, debug: bool) -> bool:
    log(f"Starting mode-{mode} stream for {duration:.0f}s…")
    send_mode_cmd(reader, mode)
    time.sleep(0.1)
    reader.poll_up()

    total_bytes = 0
    total_batches = 0
    drop_events = 0
    stall_events = 0
    last_data_t = time.time()
    last_report_t = time.time()
    start_t = time.time()

    window_bytes = 0
    window_start = time.time()
    rates: list[float] = []

    STALL_THRESHOLD = 5.0
    REPORT_INTERVAL = 5.0

    consecutive_errors = 0

    while (time.time() - start_t) < duration:
        try:
            def on_data(_ch: int, data: bytes) -> None:
                nonlocal total_bytes, total_batches, window_bytes, last_data_t
                total_bytes += len(data)
                total_batches += 1
                window_bytes += len(data)
                last_data_t = time.time()

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

        if now - window_start >= 1.0:
            rates.append(window_bytes / (now - window_start))
            window_bytes = 0
            window_start = now

        idle_secs = now - last_data_t
        if idle_secs >= STALL_THRESHOLD and total_bytes > 0:
            stall_events += 1
            log(
                f"  STALL detected — no data for {idle_secs:.1f}s  "
                f"(total {total_bytes} bytes, {total_batches} batches, "
                f"{stall_events} stalls so far)"
            )
            last_data_t = now

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
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


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
    repo_root_str = str(REPO_ROOT).replace("\\", "/")
    cache_norm = text.replace("\\", "/")
    stale = "CMAKE_MAKE_PROGRAM:FILEPATH=/opt/" in cache_norm
    if not stale:
        for line in text.splitlines():
            if line.startswith("CMAKE_HOME_DIRECTORY:INTERNAL="):
                home = line.split("=", 1)[1].replace("\\", "/")
                if home and not home.startswith(repo_root_str):
                    stale = True
                break
    if not stale:
        for line in text.splitlines():
            if line.startswith("CMAKE_MAKE_PROGRAM:FILEPATH="):
                if not Path(line.split("=", 1)[1]).exists():
                    stale = True
                break
    if stale:
        log("Removing stale CMake cache before reconfigure")
        cache.unlink(missing_ok=True)
        shutil.rmtree(files_dir, ignore_errors=True)


def resolve_openocd_bin(requested: str | None) -> str:
    path = requested or os.environ.get("PROBESTREAM_OPENOCD_BIN")
    if path and Path(path).exists():
        return path
    fallback = shutil.which("openocd") or shutil.which("openocd.exe")
    if fallback:
        if path:
            log(f"OpenOCD not found at {path}; using {fallback}")
        return fallback
    die("OpenOCD binary not found. Set PROBESTREAM_OPENOCD_BIN or pass --openocd-bin.")


def resolve_openocd_scripts(requested: str | None, ocd_target: str) -> Path:
    path = requested or os.environ.get("PROBESTREAM_OPENOCD_SCRIPTS")
    if path:
        p = Path(path)
        if (p / "interface" / "stlink.cfg").exists() and (p / ocd_target).exists():
            return p
    die(f"OpenOCD scripts dir not found (need {ocd_target}). "
        f"Set PROBESTREAM_OPENOCD_SCRIPTS or pass --openocd-scripts.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="ProbeStream streaming test harness")
    parser.add_argument("--board", required=True, choices=sorted(BOARDS),
                        help="Target board: g474 (Nucleo-G474RE) or u385 (Nucleo-U385)")
    parser.add_argument("--duration", type=float, default=120, metavar="S",
                        help="Stream duration in seconds (default 120)")
    parser.add_argument("--mode", type=int, default=5,
                        help="Firmware test mode (default 5 = realistic periodic)")
    parser.add_argument("--skip-flash", action="store_true",
                        help="Skip build + flash; board must already have stress firmware")
    parser.add_argument("--skip-build", action="store_true",
                        help="Skip CMake rebuild; flash existing build_stress/ ELF")
    parser.add_argument("--openocd-bin", default=None,
                        help="Path to OpenOCD binary (overrides PROBESTREAM_OPENOCD_BIN)")
    parser.add_argument("--openocd-scripts", default=None,
                        help="Path to OpenOCD scripts directory")
    parser.add_argument("--stlink-sn", default=None,
                        help="ST-LINK serial number (overrides PROBESTREAM_<BOARD>_STLINK_SN)")
    parser.add_argument("--debug", action="store_true", help="Verbose output")
    args = parser.parse_args()

    cfg = BOARDS[args.board]
    board_dir: Path = cfg["dir"]
    build_dir = board_dir / "build_stress"
    ocd_target: str = cfg["ocd_target"]
    ram_size: int = cfg["ram_size"]
    stlink_sn = (
        args.stlink_sn
        or os.environ.get(cfg["stlink_env"])
        or cfg["stlink_def"]
    )

    print()
    print("=" * 60)
    print(f"  ProbeStream streaming test harness  [board={args.board}]")
    print(f"  mode={args.mode}  duration={args.duration}s  ram={ram_size // 1024} KB")
    print("=" * 60)
    print()

    ocd_bin = resolve_openocd_bin(args.openocd_bin)
    scripts_dir = resolve_openocd_scripts(args.openocd_scripts, ocd_target)
    log(f"OpenOCD scripts: {scripts_dir}")
    log(f"ST-LINK serial: {stlink_sn or '(unset — using first ST-LINK found)'}")

    if not args.skip_flash:
        elf = build(board_dir, build_dir, skip_build=args.skip_build, debug=args.debug)
        flash(cfg["flash_method"], elf, ocd_bin, scripts_dir, ocd_target, stlink_sn, debug=args.debug)
        time.sleep(0.5)

    ocd = start_openocd(ocd_bin, scripts_dir, ocd_target, stlink_sn, debug=args.debug)
    try:
        tcl = OpenOcdTcl(host="localhost", port=TCL_PORT, timeout=10.0)
        tcl.connect()
        quiesce(tcl)
        reader = discover_cb(tcl, ram_size, debug=args.debug)
        time.sleep(0.3)
        reader.poll_up()
        print()
        passed = run_stream_test(reader, mode=args.mode, duration=args.duration, debug=args.debug)
        tcl.close()
        return 0 if passed else 1
    finally:
        stop_openocd(ocd)


if __name__ == "__main__":
    sys.exit(main())
