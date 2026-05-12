#!/usr/bin/env python3
"""Direct ProbeStream benchmark — no class abstraction, minimal overhead."""

import socket, struct, time, sys, statistics

TCL_PORT = 6666

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect(('localhost', TCL_PORT))
sock.settimeout(10.0)

def tcl(cmd):
    sock.sendall((cmd + '\x1a').encode())
    buf = b''
    while True:
        chunk = sock.recv(4096)
        buf += chunk
        if b'\x1a' in buf:
            break
    return buf.rstrip(b'\x1a').decode()

def mdw(addr):
    r = tcl(f'mdw 0x{addr:08X}')
    return int(r[r.find(':')+1:].strip(), 16)

def mdw_n(addr, n):
    r = tcl(f'mdw 0x{addr:08X} {n}')
    words = []
    for line in r.strip().split('\n'):
        c = line.find(':')
        if c >= 0:
            for h in line[c+1:].strip().split():
                words.append(int(h, 16))
    return words

def read_buf(addr, count):
    a_start = addr & ~3
    a_end = (addr + count + 3) & ~3
    wc = (a_end - a_start) // 4
    raw = bytearray()
    off = 0
    while off < wc:
        c = min(32, wc - off)
        for w in mdw_n(a_start + off*4, c):
            raw.extend(struct.pack('<I', w))
        off += c
    byte_off = addr - a_start
    return bytes(raw[byte_off:byte_off + count])

def write_bytes_fast(addr, data):
    """Write bytes using mww where aligned, mwb for remainder."""
    off = 0
    while off < len(data) and (addr + off) % 4 != 0:
        tcl(f'mwb 0x{addr+off:08X} 0x{data[off]:02X}')
        off += 1
    while off + 4 <= len(data):
        val = struct.unpack_from('<I', data, off)[0]
        tcl(f'mww 0x{addr+off:08X} 0x{val:08X}')
        off += 4
    while off < len(data):
        tcl(f'mwb 0x{addr+off:08X} 0x{data[off]:02X}')
        off += 1

def send_down(dp_buf, down_desc, msg_bytes):
    dwr = mdw(down_desc + 8)
    write_bytes_fast(dp_buf + dwr, msg_bytes)
    tcl(f'mww 0x{down_desc+8:08X} 0x{dwr+len(msg_bytes):08X}')

def drain_up(up_desc):
    for _ in range(20):
        wr = mdw(up_desc + 8)
        rd = mdw(up_desc + 12)
        if wr == rd:
            break
        tcl(f'mww 0x{up_desc+12:08X} 0x{wr:08X}')
        time.sleep(0.02)

# Known addresses from previous scan
cb = 0x200001D4
up_desc = cb + 32
down_desc = cb + 32 + 3*20  # maxUp=3

buf_addr = mdw(up_desc)
buf_size = mdw(up_desc + 4)
dp_buf = mdw(down_desc)
print(f'Up buffer: 0x{buf_addr:08X}, {buf_size} bytes')
print(f'Down buffer: 0x{dp_buf:08X}')
print()

# ============================================================
# Phase 1: Offset-only polling (theoretical max throughput)
# ============================================================
send_down(dp_buf, down_desc, b'mode 1\n')
time.sleep(0.3)
drain_up(up_desc)

total = 0
polls = 0
start = time.time()
for _ in range(500):
    wr = mdw(up_desc + 8)
    rd = mdw(up_desc + 12)
    if wr != rd:
        avail = (wr - rd) if wr > rd else (buf_size - rd + wr)
        total += avail
        tcl(f'mww 0x{up_desc+12:08X} 0x{wr:08X}')
    polls += 1
elapsed = time.time() - start

print(f'=== Phase 1: Offset-only (no data read) ===')
print(f'  {total:,} bytes in {elapsed:.2f}s')
print(f'  Throughput: {total/elapsed:,.0f} B/s  ({total/elapsed/1024:.1f} KB/s)')
print(f'  {polls} polls, {polls/elapsed:.0f}/s, avg {total/polls:.0f} B/poll')
print()

# ============================================================
# Phase 2: Full data reads
# ============================================================
send_down(dp_buf, down_desc, b'reset\n')
time.sleep(0.1)
drain_up(up_desc)
send_down(dp_buf, down_desc, b'mode 1\n')
time.sleep(0.1)

all_data = bytearray()
total2 = 0
polls2 = 0
start2 = time.time()
for _ in range(200):
    wr = mdw(up_desc + 8)
    rd = mdw(up_desc + 12)
    if wr == rd:
        polls2 += 1
        continue

    if wr > rd:
        avail = wr - rd
        data = read_buf(buf_addr + rd, avail)
    else:
        p1 = read_buf(buf_addr + rd, buf_size - rd)
        p2 = read_buf(buf_addr, wr) if wr > 0 else b''
        data = p1 + p2
        avail = len(data)

    all_data.extend(data)
    total2 += avail
    tcl(f'mww 0x{up_desc+12:08X} 0x{wr:08X}')
    polls2 += 1

elapsed2 = time.time() - start2

print(f'=== Phase 2: With data reads ===')
print(f'  {total2:,} bytes in {elapsed2:.2f}s')
print(f'  Throughput: {total2/elapsed2:,.0f} B/s  ({total2/elapsed2/1024:.1f} KB/s)')
print(f'  {polls2} polls, {polls2/elapsed2:.0f}/s')
print()

# Verify data
text = all_data.decode('ascii', errors='replace')
lines = [l for l in text.strip().split('\n') if l.startswith('S:')]
if lines:
    seqs = []
    for l in lines:
        try: seqs.append(int(l[2:]))
        except: pass
    gaps = sum(max(0, seqs[i] - seqs[i-1] - 1) for i in range(1, len(seqs)))
    ooo = sum(1 for i in range(1, len(seqs)) if seqs[i] <= seqs[i-1])
    print(f'=== Data integrity ===')
    print(f'  {len(seqs)} messages, range {seqs[0]}..{seqs[-1]}')
    print(f'  Gaps: {gaps}, Out-of-order: {ooo}')
    print(f'  Verdict: {"PASS" if ooo == 0 else "FAIL"}')
    print()

# ============================================================
# Phase 3: Latency (echo round-trip)
# ============================================================
send_down(dp_buf, down_desc, b'mode 0\n')
time.sleep(0.3)
drain_up(up_desc)
send_down(dp_buf, down_desc, b'mode 4\n')
time.sleep(0.3)
drain_up(up_desc)

latencies = []
for i in range(50):
    ping = f'P{i:03d}\n'.encode()
    send_down(dp_buf, down_desc, ping)

    t0 = time.time()
    for _ in range(200):
        wr = mdw(up_desc + 8)
        rd = mdw(up_desc + 12)
        if wr != rd:
            tcl(f'mww 0x{up_desc+12:08X} 0x{wr:08X}')
            break
        time.sleep(0.001)
    lat = (time.time() - t0) * 1000
    latencies.append(lat)

latencies.sort()
print(f'=== Phase 3: Latency (echo, 50 iterations) ===')
print(f'  Min:    {min(latencies):.1f}ms')
print(f'  Avg:    {statistics.mean(latencies):.1f}ms')
print(f'  Median: {statistics.median(latencies):.1f}ms')
print(f'  P95:    {latencies[47]:.1f}ms')
print(f'  Max:    {max(latencies):.1f}ms')
print()

# ============================================================
# Phase 4: Down-channel write throughput
# ============================================================
drain_up(up_desc)
# Already in echo mode (4)
payload = b'X' * 60 + b'\n'
total_w = 0
total_e = 0
writes = 0
start4 = time.time()

for _ in range(100):
    # Write payload to down-channel
    dwr = mdw(down_desc + 8)
    drd = mdw(down_desc + 12)
    dsize = mdw(down_desc + 4)
    avail = (drd - dwr - 1) if drd > dwr else (dsize - 1 - (dwr - drd))
    n = min(len(payload), avail)
    if n > 0:
        write_bytes_fast(dp_buf + dwr, payload[:n])
        tcl(f'mww 0x{down_desc+8:08X} 0x{(dwr+n)%dsize:08X}')
        total_w += n
        writes += 1

    # Read echo
    wr = mdw(up_desc + 8)
    rd = mdw(up_desc + 12)
    if wr != rd:
        avail_up = (wr - rd) if wr > rd else (buf_size - rd + wr)
        total_e += avail_up
        tcl(f'mww 0x{up_desc+12:08X} 0x{wr:08X}')

elapsed4 = time.time() - start4
print(f'=== Phase 4: Down-channel throughput ===')
print(f'  Written: {total_w:,} B in {elapsed4:.2f}s = {total_w/elapsed4:,.0f} B/s ({total_w/elapsed4/1024:.1f} KB/s)')
print(f'  Echoed:  {total_e:,} B = {total_e/elapsed4:,.0f} B/s ({total_e/elapsed4/1024:.1f} KB/s)')
print(f'  {writes} writes')
print()

# Cleanup
send_down(dp_buf, down_desc, b'mode 0\n')
sock.close()

print('=== SUMMARY ===')
print(f'  Up-channel (offset-only):   {total/elapsed:,.0f} B/s  ({total/elapsed/1024:.1f} KB/s)')
print(f'  Up-channel (with reads):    {total2/elapsed2:,.0f} B/s  ({total2/elapsed2/1024:.1f} KB/s)')
print(f'  Round-trip latency:         {statistics.mean(latencies):.1f}ms avg, {statistics.median(latencies):.1f}ms median')
print(f'  Down-channel write:         {total_w/elapsed4:,.0f} B/s  ({total_w/elapsed4/1024:.1f} KB/s)')
print(f'  Buffer size:                {buf_size} bytes')
