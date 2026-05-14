#!/usr/bin/env python3
"""
ProbeStream G4 benchmark — uses bulk read_memory (works on running target).
Compares against U3 (mdw-only) numbers.
"""

import socket, struct, time, sys, statistics, subprocess, os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import load_env  # noqa: F401  (loads tests/.env if present)

OPENOCD_BIN = os.environ["PROBESTREAM_OPENOCD_BIN"]
OPENOCD_SCRIPTS = os.environ["PROBESTREAM_OPENOCD_SCRIPTS"]
G4_STLINK_SN = os.environ.get("PROBESTREAM_G4_STLINK_SN", "0033004B3033510735393935")

TCL_PORT = 6666
MAGIC = b"ProbeStream\x00\x00\x00\x00\x00"
RAM_START = 0x20000000
RAM_SIZE = 128 * 1024  # G474 has 128KB RAM


def start_openocd():
    proc = subprocess.Popen(
        [OPENOCD_BIN, "-s", OPENOCD_SCRIPTS,
         "-c", f"adapter serial {G4_STLINK_SN}",
         "-f", "interface/stlink.cfg",
         "-f", "target/stm32g4x.cfg"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(2)
    if proc.poll() is not None:
        print("OpenOCD failed to start")
        sys.exit(1)
    return proc


class Tcl:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(10.0)
        self.sock.connect(('localhost', TCL_PORT))

    def send(self, cmd):
        self.sock.sendall((cmd + '\x1a').encode())
        buf = b''
        while True:
            chunk = self.sock.recv(8192)
            buf += chunk
            if b'\x1a' in buf:
                break
        return buf.rstrip(b'\x1a').decode('ascii', errors='replace')

    def mdw(self, addr):
        r = self.send(f'mdw 0x{addr:08X}')
        return int(r[r.find(':')+1:].strip(), 16)

    def mww(self, addr, val):
        self.send(f'mww 0x{addr:08X} 0x{val:08X}')

    def read_mem_bytes(self, addr, count):
        """Use read_memory with 8-bit width — works on G4 running target."""
        # Chunk large reads
        out = bytearray()
        off = 0
        while off < count:
            chunk = min(1024, count - off)
            r = self.send(f'read_memory 0x{addr+off:08X} 8 {chunk}')
            out.extend(int(x, 16) for x in r.strip().split())
            off += chunk
        return bytes(out)

    def read_mem_words(self, addr, word_count):
        """32-bit-word read — fastest path."""
        out = bytearray()
        off = 0
        while off < word_count:
            chunk = min(256, word_count - off)
            r = self.send(f'read_memory 0x{addr+off*4:08X} 32 {chunk}')
            for h in r.strip().split():
                out.extend(struct.pack('<I', int(h, 16)))
            off += chunk
        return bytes(out)

    def write_mem_bytes(self, addr, data):
        """Write bytes using mww for word-aligned regions and mwb for the rest."""
        off = 0
        while off < len(data) and (addr + off) % 4 != 0:
            self.send(f'mwb 0x{addr+off:08X} 0x{data[off]:02X}')
            off += 1
        while off + 4 <= len(data):
            val = struct.unpack_from('<I', data, off)[0]
            self.send(f'mww 0x{addr+off:08X} 0x{val:08X}')
            off += 4
        while off < len(data):
            self.send(f'mwb 0x{addr+off:08X} 0x{data[off]:02X}')
            off += 1

    def close(self):
        self.sock.close()


def find_cb(tcl):
    """Scan RAM for ProbeStream magic. G4 read_memory works while running."""
    print("Scanning RAM for ProbeStream magic (running target)...")
    for offset in range(0, RAM_SIZE, 4096):
        try:
            data = tcl.read_mem_bytes(RAM_START + offset, 4096)
        except Exception:
            continue
        idx = data.find(MAGIC)
        if idx >= 0:
            addr = RAM_START + offset + idx
            print(f"  Found at 0x{addr:08X}")
            return addr
    return None


def _read_words_aligned(tcl, addr, count):
    """Read `count` bytes starting at `addr` using 32-bit word read_memory.
    Handles unaligned start/end via 1-2 byte mdw reads at boundaries."""
    if count == 0:
        return b''
    a_start = addr & ~3
    a_end = (addr + count + 3) & ~3
    word_count = (a_end - a_start) // 4
    raw = tcl.read_mem_words(a_start, word_count)
    byte_off = addr - a_start
    return raw[byte_off:byte_off + count]


class Bench:
    def __init__(self, tcl, cb):
        self.tcl = tcl
        self.cb = cb
        self.num_up = tcl.mdw(cb + 16)
        self.num_down = tcl.mdw(cb + 20)
        self.max_up = tcl.mdw(cb + 24)
        self.max_down = tcl.mdw(cb + 28)
        # Cache buffer addrs
        ud = cb + 32
        self.up_desc = ud
        self.up_buf = tcl.mdw(ud)
        self.up_size = tcl.mdw(ud + 4)
        dd = cb + 32 + self.max_up * 20
        self.down_desc = dd
        self.down_buf = tcl.mdw(dd)
        self.down_size = tcl.mdw(dd + 4)
        print(f"  Up:   desc=0x{ud:08X} buf=0x{self.up_buf:08X} size={self.up_size}")
        print(f"  Down: desc=0x{dd:08X} buf=0x{self.down_buf:08X} size={self.down_size}")

    def read_up_bulk(self):
        """Read available up-channel data via word-mode read_memory (fast path)."""
        wr = self.tcl.mdw(self.up_desc + 8)
        rd = self.tcl.mdw(self.up_desc + 12)
        if wr == rd:
            return b''
        if wr > rd:
            data = _read_words_aligned(self.tcl, self.up_buf + rd, wr - rd)
        else:
            p1 = _read_words_aligned(self.tcl, self.up_buf + rd, self.up_size - rd)
            p2 = _read_words_aligned(self.tcl, self.up_buf, wr) if wr > 0 else b''
            data = p1 + p2
        self.tcl.mww(self.up_desc + 12, wr)
        return data

    def write_down(self, payload):
        wr = self.tcl.mdw(self.down_desc + 8)
        rd = self.tcl.mdw(self.down_desc + 12)
        avail = (rd - wr - 1) if rd > wr else (self.down_size - 1 - (wr - rd))
        n = min(len(payload), avail)
        if n == 0:
            return 0
        if wr + n <= self.down_size:
            self.tcl.write_mem_bytes(self.down_buf + wr, payload[:n])
            new_wr = (wr + n) % self.down_size
        else:
            first = self.down_size - wr
            self.tcl.write_mem_bytes(self.down_buf + wr, payload[:first])
            rest = n - first
            if rest > 0:
                self.tcl.write_mem_bytes(self.down_buf, payload[first:first+rest])
            new_wr = rest
        self.tcl.mww(self.down_desc + 8, new_wr)
        return n

    def cmd(self, c):
        payload = (c + '\n').encode()
        written = 0
        for _ in range(50):
            n = self.write_down(payload[written:])
            written += n
            if written >= len(payload):
                break
            time.sleep(0.02)

    def drain(self, timeout=0.5):
        out = b''
        deadline = time.time() + timeout
        while time.time() < deadline:
            d = self.read_up_bulk()
            if d:
                out += d
                deadline = time.time() + 0.2
            else:
                time.sleep(0.02)
        return out.decode('ascii', errors='replace')


def main():
    print("=" * 60)
    print("ProbeStream G4 Benchmark (Nucleo G474RE)")
    print("=" * 60)

    # Allow connecting to an externally-managed OpenOCD via env var
    if os.environ.get('PS_USE_EXISTING_OCD'):
        ocd = None
        print("Using existing OpenOCD on port 6666")
    else:
        ocd = start_openocd()
    try:
        tcl = Tcl()
        cb = find_cb(tcl)
        if not cb:
            print("Control block not found")
            return 1

        bench = Bench(tcl, cb)
        boot = bench.drain(timeout=1.0)
        print(f"  Boot: {boot.strip()}")
        print()

        # ============================================================
        # Phase 1: Offset-only (max polling rate)
        # ============================================================
        bench.cmd("mode 0")
        time.sleep(0.2)
        bench.drain()
        bench.cmd("reset")
        time.sleep(0.1)
        bench.drain()
        bench.cmd("mode 1")
        time.sleep(0.1)

        total = 0
        polls = 0
        start = time.time()
        for _ in range(500):
            wr = tcl.mdw(bench.up_desc + 8)
            rd = tcl.mdw(bench.up_desc + 12)
            if wr != rd:
                avail = (wr - rd) if wr > rd else (bench.up_size - rd + wr)
                total += avail
                tcl.mww(bench.up_desc + 12, wr)
            polls += 1
        elapsed = time.time() - start
        print(f"=== Phase 1: Offset-only (no data read) ===")
        print(f"  {total:,} bytes in {elapsed:.2f}s")
        print(f"  Throughput: {total/elapsed:,.0f} B/s  ({total/elapsed/1024:.1f} KB/s)")
        print(f"  {polls} polls, {polls/elapsed:.0f}/s")
        print()
        phase1_bps = total / elapsed

        # ============================================================
        # Phase 2: Bulk read_memory data reads
        # ============================================================
        bench.cmd("mode 0")
        time.sleep(0.2)
        bench.drain()
        bench.cmd("reset")
        time.sleep(0.1)
        bench.drain()
        bench.cmd("mode 1")
        time.sleep(0.1)

        all_data = bytearray()
        total2 = 0
        polls2 = 0
        start2 = time.time()
        for _ in range(300):
            data = bench.read_up_bulk()
            if data:
                all_data.extend(data)
                total2 += len(data)
            polls2 += 1

        elapsed2 = time.time() - start2
        print(f"=== Phase 2: With bulk read_memory ===")
        print(f"  {total2:,} bytes in {elapsed2:.2f}s")
        print(f"  Throughput: {total2/elapsed2:,.0f} B/s  ({total2/elapsed2/1024:.1f} KB/s)")
        print(f"  {polls2} polls, {polls2/elapsed2:.0f}/s")
        print()
        phase2_bps = total2 / elapsed2

        # Integrity check
        text = all_data.decode('ascii', errors='replace')
        lines = [l for l in text.strip().split('\n') if l.startswith('S:')]
        if lines:
            seqs = []
            for l in lines:
                try: seqs.append(int(l[2:]))
                except: pass
            gaps = sum(max(0, seqs[i] - seqs[i-1] - 1) for i in range(1, len(seqs)))
            ooo = sum(1 for i in range(1, len(seqs)) if seqs[i] <= seqs[i-1])
            print(f"=== Data integrity ===")
            print(f"  {len(seqs)} messages, range {seqs[0]}..{seqs[-1]}")
            print(f"  Gaps: {gaps}, Out-of-order: {ooo}")
            print(f"  Verdict: {'PASS' if ooo == 0 else 'FAIL'}")
            print()

        # ============================================================
        # Phase 3: Latency
        # ============================================================
        bench.cmd("mode 0")
        time.sleep(0.3)
        bench.drain()
        bench.cmd("mode 4")
        time.sleep(0.3)
        bench.drain()

        latencies = []
        for i in range(50):
            ping = f'P{i:03d}\n'.encode()
            t0 = time.time()
            bench.write_down(ping)
            for _ in range(200):
                d = bench.read_up_bulk()
                if d:
                    break
                time.sleep(0.001)
            latencies.append((time.time() - t0) * 1000)
        latencies.sort()
        print(f"=== Phase 3: Latency (50 iter, echo) ===")
        print(f"  Min: {min(latencies):.1f}ms  Avg: {statistics.mean(latencies):.1f}ms  "
              f"Med: {statistics.median(latencies):.1f}ms  P95: {latencies[47]:.1f}ms  "
              f"Max: {max(latencies):.1f}ms")
        print()

        # ============================================================
        # Phase 4: Down-channel throughput (echo mode)
        # ============================================================
        bench.drain()
        bench.cmd("mode 4")
        time.sleep(0.3)
        bench.drain()

        payload = b'X' * 60 + b'\n'
        total_w = 0
        total_e = 0
        writes = 0
        start4 = time.time()
        for _ in range(150):
            n = bench.write_down(payload)
            total_w += n
            writes += 1
            d = bench.read_up_bulk()
            total_e += len(d)
        elapsed4 = time.time() - start4
        print(f"=== Phase 4: Down-channel write/echo ===")
        print(f"  Written: {total_w:,} B  ({total_w/elapsed4:,.0f} B/s, {total_w/elapsed4/1024:.1f} KB/s)")
        print(f"  Echoed:  {total_e:,} B  ({total_e/elapsed4:,.0f} B/s, {total_e/elapsed4/1024:.1f} KB/s)")
        print(f"  {writes} writes")
        print()
        down_bps = total_w / elapsed4

        bench.cmd("mode 0")
        time.sleep(0.2)

        # ============================================================
        # Summary
        # ============================================================
        print("=" * 60)
        print("SUMMARY (G4)")
        print("=" * 60)
        print(f"  Up-channel offset-only:    {phase1_bps:>10,.0f} B/s  ({phase1_bps/1024:.1f} KB/s)")
        print(f"  Up-channel with reads:     {phase2_bps:>10,.0f} B/s  ({phase2_bps/1024:.1f} KB/s)")
        print(f"  Down-channel write:        {down_bps:>10,.0f} B/s  ({down_bps/1024:.1f} KB/s)")
        print(f"  Round-trip latency:        avg={statistics.mean(latencies):.1f}ms  med={statistics.median(latencies):.1f}ms  p95={latencies[47]:.1f}ms")

        tcl.close()
        return 0
    finally:
        if ocd is not None:
            ocd.terminate()
            try:
                ocd.wait(timeout=3)
            except subprocess.TimeoutExpired:
                ocd.kill()


if __name__ == "__main__":
    sys.exit(main())
