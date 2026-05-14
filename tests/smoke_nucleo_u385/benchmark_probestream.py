#!/usr/bin/env python3
"""
ProbeStream throughput benchmark.

Uses mdw/mww for non-halting memory access (same approach as ViewAlyzer-App).
"""

import socket
import struct
import subprocess
import sys
import time
import os
import statistics
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import load_env  # noqa: F401  (loads tests/.env if present)

OPENOCD_BIN = os.environ["PROBESTREAM_OPENOCD_BIN"]
OPENOCD_SCRIPTS = os.environ["PROBESTREAM_OPENOCD_SCRIPTS"]
STM32_PROGRAMMER = os.environ["PROBESTREAM_STM32_PROGRAMMER"]
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ELF_PATH = os.path.join(SCRIPT_DIR, "build_stress/PS_Smoke.elf")
HEX_PATH = os.path.join(SCRIPT_DIR, "build_stress/PS_Smoke.hex")

TCL_PORT = 6666
MAGIC = b"ProbeStream\x00\x00\x00\x00\x00"
RAM_START = 0x20000000
RAM_SIZE = 192 * 1024


class OpenOcdTcl:
    """OpenOCD TCL-RPC client using mdw/mww for non-halting access."""

    def __init__(self, host="localhost", port=TCL_PORT):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((host, port))
        self.sock.settimeout(15.0)

    def send(self, cmd: str) -> str:
        data = cmd.encode("ascii") + b"\x1a"
        self.sock.sendall(data)
        return self._recv()

    def _recv(self) -> str:
        buf = b""
        while True:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            if b"\x1a" in buf:
                break
        return buf.rstrip(b"\x1a").decode("ascii", errors="replace")

    def mdw(self, addr: int) -> int:
        """Read single 32-bit word (works on running target)."""
        resp = self.send(f"mdw 0x{addr:08X}")
        colon = resp.find(":")
        if colon < 0:
            raise RuntimeError(f"mdw parse error: {resp!r}")
        return int(resp[colon + 1:].strip(), 16)

    def mdw_n(self, addr: int, count: int) -> list[int]:
        """Read N 32-bit words. Returns list of uint32 values."""
        resp = self.send(f"mdw 0x{addr:08X} {count}")
        words = []
        for line in resp.strip().split("\n"):
            colon = line.find(":")
            if colon < 0:
                continue
            for h in line[colon + 1:].strip().split():
                words.append(int(h, 16))
        return words

    def read_bytes(self, addr: int, count: int) -> bytes:
        """Read arbitrary bytes using mdw, word-aligned. Max ~512 bytes per call."""
        if count == 0:
            return b""
        # Align down to word boundary
        aligned_start = addr & ~3
        aligned_end = (addr + count + 3) & ~3
        word_count = (aligned_end - aligned_start) // 4

        # Read in chunks of 32 words (128 bytes) max per mdw call
        all_bytes = bytearray()
        words_read = 0
        while words_read < word_count:
            chunk = min(32, word_count - words_read)
            words = self.mdw_n(aligned_start + words_read * 4, chunk)
            for w in words:
                all_bytes.extend(struct.pack("<I", w))
            words_read += chunk

        # Slice to exact requested range
        byte_offset = addr - aligned_start
        return bytes(all_bytes[byte_offset:byte_offset + count])

    def mww(self, addr: int, val: int):
        """Write a 32-bit word."""
        self.send(f"mww 0x{addr:08X} 0x{val:08X}")

    def mwb(self, addr: int, val: int):
        """Write a single byte."""
        self.send(f"mwb 0x{addr:08X} 0x{val:02X}")

    def write_bytes(self, addr: int, data: bytes):
        """Write bytes using mww for aligned words, mwb for remainder."""
        off = 0
        while off < len(data) and (addr + off) % 4 != 0:
            self.mwb(addr + off, data[off])
            off += 1
        while off + 4 <= len(data):
            val = struct.unpack_from("<I", data, off)[0]
            self.mww(addr + off, val)
            off += 4
        while off < len(data):
            self.mwb(addr + off, data[off])
            off += 1

    # For initial halted scan only
    def read_memory_halted(self, addr: int, count: int) -> bytes:
        MAX_CHUNK = 256
        out = bytearray()
        off = 0
        while off < count:
            chunk = min(MAX_CHUNK, count - off)
            result = self.send(f"read_memory 0x{addr + off:08x} 8 {chunk}")
            parts = result.strip().split()
            out.extend(int(x, 16) for x in parts)
            off += chunk
        return bytes(out)

    def close(self):
        self.sock.close()


def flash_firmware():
    print(f"Flashing stress test firmware...")
    subprocess.run(
        ["arm-none-eabi-objcopy", "-O", "ihex", ELF_PATH, HEX_PATH],
        check=True,
    )
    result = subprocess.run(
        [
            STM32_PROGRAMMER, "-c", "port=SWD", "mode=UR",
            "-e", "all", "-w", HEX_PATH, "-v", "-rst",
        ],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        print(f"Flash FAILED:\n{result.stdout}\n{result.stderr}")
        return False
    print("  Flash OK")
    return True


def find_control_block(tcl: OpenOcdTcl) -> int | None:
    print("Scanning RAM for ProbeStream magic (halted)...")
    for offset in range(0, RAM_SIZE, 1024):
        addr = RAM_START + offset
        try:
            data = tcl.read_memory_halted(addr, 1024)
        except Exception:
            continue
        idx = data.find(MAGIC)
        if idx >= 0:
            cb_addr = addr + idx
            print(f"  Found at 0x{cb_addr:08X}")
            return cb_addr
    return None


class ProbeStreamBench:
    """Non-halting ProbeStream host reader for benchmarking."""

    def __init__(self, tcl: OpenOcdTcl, cb_addr: int):
        self.tcl = tcl
        self.cb_addr = cb_addr
        self.num_up = tcl.mdw(cb_addr + 16)
        self.num_down = tcl.mdw(cb_addr + 20)
        self.max_up = tcl.mdw(cb_addr + 24)
        self.max_down = tcl.mdw(cb_addr + 28)
        print(f"  numUp={self.num_up} numDown={self.num_down} "
              f"maxUp={self.max_up} maxDown={self.max_down}")

        # Cache static channel info
        self._up = []
        for ch in range(self.num_up):
            desc = cb_addr + 32 + ch * 20
            self._up.append({
                "desc": desc,
                "buf": tcl.mdw(desc),
                "size": tcl.mdw(desc + 4),
            })

        self._down = []
        for ch in range(self.num_down):
            desc = cb_addr + 32 + self.max_up * 20 + ch * 20
            self._down.append({
                "desc": desc,
                "buf": tcl.mdw(desc),
                "size": tcl.mdw(desc + 4),
            })

    def read_up(self, ch=0) -> bytes:
        """Read available data from up-channel. Non-halting."""
        c = self._up[ch]
        wr = self.tcl.mdw(c["desc"] + 8)
        rd = self.tcl.mdw(c["desc"] + 12)

        if wr == rd:
            return b""

        buf_addr = c["buf"]
        buf_size = c["size"]

        if wr > rd:
            data = self.tcl.read_bytes(buf_addr + rd, wr - rd)
        else:
            part1 = self.tcl.read_bytes(buf_addr + rd, buf_size - rd)
            part2 = self.tcl.read_bytes(buf_addr, wr) if wr > 0 else b""
            data = part1 + part2

        self.tcl.mww(c["desc"] + 12, wr)
        return data

    def write_down(self, ch, payload: bytes) -> int:
        """Write to down-channel. Non-halting."""
        c = self._down[ch]
        wr = self.tcl.mdw(c["desc"] + 8)
        rd = self.tcl.mdw(c["desc"] + 12)
        size = c["size"]

        avail = (rd - wr - 1) if rd > wr else (size - 1 - (wr - rd))
        n = min(len(payload), avail)
        if n == 0:
            return 0

        buf_addr = c["buf"]
        if wr + n <= size:
            self.tcl.write_bytes(buf_addr + wr, payload[:n])
            new_wr = (wr + n) % size
        else:
            first = size - wr
            self.tcl.write_bytes(buf_addr + wr, payload[:first])
            rest = n - first
            if rest > 0:
                self.tcl.write_bytes(buf_addr, payload[first:first + rest])
            new_wr = rest

        self.tcl.mww(c["desc"] + 8, new_wr)
        return n

    def send_cmd(self, cmd: str):
        payload = (cmd + "\n").encode()
        written = 0
        for _ in range(50):
            n = self.write_down(0, payload[written:])
            written += n
            if written >= len(payload):
                break
            time.sleep(0.05)

    def drain(self, ch=0, timeout=2.0) -> str:
        out = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            data = self.read_up(ch)
            if data:
                out += data
                deadline = time.time() + 0.3
            else:
                time.sleep(0.02)
        return out.decode("ascii", errors="replace")


def benchmark_up(bench, mode, name, duration=10.0):
    print(f"\n{'='*60}")
    print(f"UP-CHANNEL: {name} (mode {mode}, {duration}s)")
    print(f"{'='*60}")

    bench.send_cmd("mode 0")
    time.sleep(0.2)
    bench.drain(timeout=0.3)
    bench.send_cmd("reset")
    time.sleep(0.1)
    bench.drain(timeout=0.3)
    bench.send_cmd(f"mode {mode}")
    # Don't drain here — let the measurement loop capture everything

    total_bytes = 0
    poll_count = 0
    nonempty = 0
    poll_times = []
    bytes_per_poll = []
    start = time.time()

    while time.time() - start < duration:
        t0 = time.time()
        data = bench.read_up(0)
        dt = time.time() - t0
        poll_times.append(dt)
        poll_count += 1
        n = len(data)
        if n > 0:
            total_bytes += n
            nonempty += 1
            bytes_per_poll.append(n)

    elapsed = time.time() - start
    bench.send_cmd("mode 0")
    time.sleep(0.2)

    bench.send_cmd("stats")
    time.sleep(0.2)
    stats = bench.drain(timeout=0.5)

    tp = total_bytes / elapsed
    print(f"  Total bytes:     {total_bytes:,}")
    print(f"  Duration:        {elapsed:.1f}s")
    print(f"  Throughput:      {tp:,.0f} B/s  ({tp/1024:.2f} KB/s)")
    print(f"  Polls:           {poll_count} ({nonempty} non-empty, "
          f"{100*nonempty/poll_count:.0f}%)")
    if poll_times:
        print(f"  Poll time avg:   {statistics.mean(poll_times)*1000:.1f}ms")
        print(f"  Poll rate:       {poll_count/elapsed:.0f}/s")
    if bytes_per_poll:
        print(f"  Bytes/poll avg:  {statistics.mean(bytes_per_poll):.0f}")
        print(f"  Bytes/poll max:  {max(bytes_per_poll)}")
    for line in stats.strip().split("\n"):
        if "[stats" in line:
            print(f"  FW stats:        {line.strip()}")

    return {"name": name, "throughput_bps": tp, "bytes": total_bytes, "elapsed": elapsed}


def benchmark_latency(bench, iterations=100):
    print(f"\n{'='*60}")
    print(f"LATENCY: Round-trip echo ({iterations} iterations)")
    print(f"{'='*60}")

    bench.drain(timeout=0.3)
    bench.send_cmd("mode 4")
    time.sleep(0.2)
    bench.drain(timeout=0.3)

    latencies = []
    for i in range(iterations):
        msg = f"P{i:05d}\n"
        t0 = time.time()
        bench.write_down(0, msg.encode())
        received = b""
        deadline = time.time() + 2.0
        while time.time() < deadline:
            data = bench.read_up(0)
            if data:
                received += data
                if b"\n" in received:
                    break
            time.sleep(0.001)
        lat = (time.time() - t0) * 1000
        latencies.append(lat)

    bench.send_cmd("mode 0")
    time.sleep(0.2)
    bench.drain(timeout=0.3)

    latencies.sort()
    print(f"  Min:    {min(latencies):.1f}ms")
    print(f"  Avg:    {statistics.mean(latencies):.1f}ms")
    print(f"  Median: {statistics.median(latencies):.1f}ms")
    print(f"  P95:    {latencies[int(len(latencies)*0.95)]:.1f}ms")
    print(f"  P99:    {latencies[int(len(latencies)*0.99)]:.1f}ms")
    print(f"  Max:    {max(latencies):.1f}ms")

    return {
        "name": "latency",
        "avg_ms": statistics.mean(latencies),
        "median_ms": statistics.median(latencies),
        "p95_ms": latencies[int(len(latencies)*0.95)],
    }


def benchmark_down(bench, duration=10.0):
    print(f"\n{'='*60}")
    print(f"DOWN-CHANNEL: Write + echo ({duration}s)")
    print(f"{'='*60}")

    bench.drain(timeout=0.3)
    bench.send_cmd("mode 4")
    time.sleep(0.2)
    bench.drain(timeout=0.3)

    payload = b"XYZW" * 15 + b"\n"  # 61 bytes
    total_written = 0
    total_echoed = 0
    writes = 0
    start = time.time()

    while time.time() - start < duration:
        n = bench.write_down(0, payload)
        total_written += n
        writes += 1
        data = bench.read_up(0)
        total_echoed += len(data)

    elapsed = time.time() - start
    bench.send_cmd("mode 0")
    remaining = bench.drain(timeout=1.0)
    total_echoed += len(remaining)

    w_tp = total_written / elapsed
    e_tp = total_echoed / elapsed
    print(f"  Written:      {total_written:,} B  ({w_tp:,.0f} B/s, {w_tp/1024:.2f} KB/s)")
    print(f"  Echoed:       {total_echoed:,} B  ({e_tp:,.0f} B/s, {e_tp/1024:.2f} KB/s)")
    print(f"  Writes:       {writes}")

    return {"name": "down_channel", "write_bps": w_tp, "echo_bps": e_tp}


def benchmark_integrity(bench, duration=10.0):
    print(f"\n{'='*60}")
    print(f"INTEGRITY: Sequence check ({duration}s)")
    print(f"{'='*60}")

    bench.send_cmd("mode 0")
    time.sleep(0.2)
    bench.drain(timeout=0.3)
    bench.send_cmd("reset")
    time.sleep(0.1)
    bench.drain(timeout=0.3)
    bench.send_cmd("mode 1")

    all_data = ""
    total_bytes = 0
    start = time.time()

    while time.time() - start < duration:
        data = bench.read_up(0)
        if data:
            all_data += data.decode("ascii", errors="replace")
            total_bytes += len(data)

    bench.send_cmd("mode 0")
    time.sleep(0.2)
    elapsed = time.time() - start

    lines = [l for l in all_data.strip().split("\n") if l.startswith("S:")]
    if not lines:
        print("  ERROR: No data received")
        return {"name": "integrity", "ok": False}

    seqs = []
    errors = 0
    for l in lines:
        try:
            seqs.append(int(l[2:]))
        except ValueError:
            errors += 1

    gaps = 0
    ooo = 0
    for i in range(1, len(seqs)):
        d = seqs[i] - seqs[i-1]
        if d > 1:
            gaps += d - 1
        elif d < 0:
            ooo += 1

    total_range = seqs[-1] - seqs[0] + 1 if seqs else 0
    pct = len(seqs) / total_range * 100 if total_range else 0

    print(f"  Bytes:       {total_bytes:,}")
    print(f"  Messages:    {len(seqs):,}")
    print(f"  Seq range:   {seqs[0]}..{seqs[-1]} ({total_range:,})")
    print(f"  Received:    {pct:.1f}%")
    print(f"  Gaps:        {gaps:,}")
    print(f"  Out-of-order:{ooo}")
    print(f"  Parse errors:{errors}")
    ok = ooo == 0 and errors == 0
    print(f"  Verdict:     {'PASS' if ok else 'FAIL'}")

    return {"name": "integrity", "ok": ok, "received_pct": pct, "gaps": gaps}


def main():
    if not flash_firmware():
        return 1

    print("\nBooting firmware (2s)...")
    time.sleep(2)

    print("Starting OpenOCD...")
    ocd = subprocess.Popen(
        [OPENOCD_BIN, "-s", OPENOCD_SCRIPTS,
         "-f", "interface/stlink.cfg", "-f", "target/stm32u3x.cfg"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    time.sleep(2)
    if ocd.poll() is not None:
        print(f"OpenOCD failed:\n{ocd.stderr.read().decode()}")
        return 1

    try:
        tcl = OpenOcdTcl()

        # Brief halt for control block scan
        tcl.send("halt")
        time.sleep(0.2)
        cb = find_control_block(tcl)
        if not cb:
            print("FAIL: control block not found")
            return 1
        tcl.send("resume")
        time.sleep(0.5)

        bench = ProbeStreamBench(tcl, cb)
        boot = bench.drain(timeout=1.0)
        print(f"  Boot: {boot.strip()}")

        results = []

        # Up-channel tests
        results.append(benchmark_up(bench, 1, "Sequential S:N\\n", 10))
        results.append(benchmark_up(bench, 2, "Bulk 256B fill", 10))
        results.append(benchmark_up(bench, 3, "Small 7B packets", 10))

        # Integrity
        results.append(benchmark_integrity(bench, 10))

        # Latency
        results.append(benchmark_latency(bench, 200))

        # Down-channel
        results.append(benchmark_down(bench, 10))

        # Summary
        print(f"\n{'='*60}")
        print("SUMMARY")
        print(f"{'='*60}")
        for r in results:
            if "throughput_bps" in r:
                tp = r["throughput_bps"]
                print(f"  {r['name']:35s}  {tp:>8,.0f} B/s  ({tp/1024:.2f} KB/s)")
            elif r["name"] == "latency":
                print(f"  {'Latency':35s}  avg={r['avg_ms']:.1f}ms  "
                      f"med={r['median_ms']:.1f}ms  p95={r['p95_ms']:.1f}ms")
            elif r["name"] == "integrity":
                print(f"  {'Integrity':35s}  {'PASS' if r['ok'] else 'FAIL'}  "
                      f"{r.get('received_pct',0):.1f}% rx  {r.get('gaps',0)} gaps")
            elif r["name"] == "down_channel":
                print(f"  {'Down write':35s}  {r['write_bps']:>8,.0f} B/s  "
                      f"({r['write_bps']/1024:.2f} KB/s)")
                print(f"  {'Down echo':35s}  {r['echo_bps']:>8,.0f} B/s  "
                      f"({r['echo_bps']/1024:.2f} KB/s)")

        return 0

    finally:
        try:
            tcl.close()
        except Exception:
            pass
        ocd.terminate()
        try:
            ocd.wait(timeout=5)
        except subprocess.TimeoutExpired:
            ocd.kill()
            ocd.wait(timeout=3)
        print("\nOpenOCD stopped.")


if __name__ == "__main__":
    sys.exit(main())
