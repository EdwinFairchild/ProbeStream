#!/usr/bin/env python3
"""Unit tests for ProbeStreamReader using fake memory."""

import struct
import unittest

# Adjust path for direct script execution
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from probestream_reader import (
    ProbeStreamReader,
    MAGIC,
    MAGIC_LEN,
    HEADER_SIZE,
    CH_DESC_SIZE,
    CH_OFF_PBUFFER,
    CH_OFF_SIZE,
    CH_OFF_WROFF,
    CH_OFF_RDOFF,
    CH_OFF_FLAGS,
    CHANNEL_TYPE_FLOAT32,
    CHANNEL_TYPE_SHIFT,
    up_channel_offset,
    down_channel_offset,
)


class FakeOpenOcdTcl:
    """Fake OpenOCD TCL client backed by an in-memory buffer."""

    def __init__(self, mem_size: int = 64 * 1024, base_addr: int = 0x20000000):
        self.base = base_addr
        self.mem = bytearray(mem_size)

    def read_u32(self, addr: int) -> int:
        off = addr - self.base
        return struct.unpack_from("<I", self.mem, off)[0]

    def mdw_n(self, addr: int, count: int) -> list[int]:
        return [self.read_u32(addr + i * 4) for i in range(count)]

    def write_u32(self, addr: int, val: int) -> None:
        off = addr - self.base
        struct.pack_into("<I", self.mem, off, val)

    def read_bytes(self, addr: int, count: int, mode: str = "auto") -> bytes:
        off = addr - self.base
        return bytes(self.mem[off:off + count])

    def write_bytes(self, addr: int, data: bytes) -> None:
        off = addr - self.base
        self.mem[off:off + len(data)] = data

    @property
    def connected(self):
        return True

    def _write_raw(self, addr: int, data: bytes) -> None:
        off = addr - self.base
        self.mem[off:off + len(data)] = data


def build_control_block(
    tcl: FakeOpenOcdTcl,
    cb_addr: int,
    num_up: int = 1,
    num_down: int = 1,
    max_up: int = 1,
    max_down: int = 1,
    up_buf_addr: int = 0,
    up_buf_size: int = 256,
    up_flags: int = 0,
    down_buf_addr: int = 0,
    down_buf_size: int = 128,
):
    base = cb_addr - tcl.base

    # Magic
    tcl.mem[base:base + MAGIC_LEN] = MAGIC

    # Header
    struct.pack_into("<I", tcl.mem, base + 16, num_up)
    struct.pack_into("<I", tcl.mem, base + 20, num_down)
    struct.pack_into("<I", tcl.mem, base + 24, max_up)
    struct.pack_into("<I", tcl.mem, base + 28, max_down)

    # Up channel 0
    up_desc = base + HEADER_SIZE
    if up_buf_addr == 0:
        up_buf_addr = cb_addr + 1024
    struct.pack_into("<I", tcl.mem, up_desc + CH_OFF_PBUFFER, up_buf_addr)
    struct.pack_into("<I", tcl.mem, up_desc + CH_OFF_SIZE, up_buf_size)
    struct.pack_into("<I", tcl.mem, up_desc + CH_OFF_WROFF, 0)
    struct.pack_into("<I", tcl.mem, up_desc + CH_OFF_RDOFF, 0)
    struct.pack_into("<I", tcl.mem, up_desc + CH_OFF_FLAGS, up_flags)

    # Down channel 0
    down_desc = base + HEADER_SIZE + max_up * CH_DESC_SIZE
    if down_buf_addr == 0:
        down_buf_addr = cb_addr + 2048
    struct.pack_into("<I", tcl.mem, down_desc + CH_OFF_PBUFFER, down_buf_addr)
    struct.pack_into("<I", tcl.mem, down_desc + CH_OFF_SIZE, down_buf_size)
    struct.pack_into("<I", tcl.mem, down_desc + CH_OFF_WROFF, 0)
    struct.pack_into("<I", tcl.mem, down_desc + CH_OFF_RDOFF, 0)
    struct.pack_into("<I", tcl.mem, down_desc + CH_OFF_FLAGS, 0)

    return up_buf_addr, down_buf_addr


class TestDiscover(unittest.TestCase):
    def test_discover_finds_magic(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        build_control_block(tcl, cb_addr)

        reader = ProbeStreamReader(tcl)
        found = reader.discover(0x20000000, 64 * 1024, 1024)
        self.assertTrue(found)
        self.assertEqual(reader.cb_addr, cb_addr)
        self.assertEqual(reader.num_up, 1)
        self.assertEqual(reader.num_down, 1)

    def test_discover_not_found(self):
        tcl = FakeOpenOcdTcl()
        reader = ProbeStreamReader(tcl)
        found = reader.discover(0x20000000, 64 * 1024, 1024)
        self.assertFalse(found)

    def test_attach_at_known_addr(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000200
        build_control_block(tcl, cb_addr)

        reader = ProbeStreamReader(tcl)
        ok = reader.attach(cb_addr)
        self.assertTrue(ok)
        self.assertTrue(reader.attached)

    def test_attach_bad_addr(self):
        tcl = FakeOpenOcdTcl()
        reader = ProbeStreamReader(tcl)
        ok = reader.attach(0x20000000)
        self.assertFalse(ok)


class TestPollUp(unittest.TestCase):
    def test_channel_type_from_flags(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        flags = CHANNEL_TYPE_FLOAT32 << CHANNEL_TYPE_SHIFT
        build_control_block(tcl, cb_addr, up_flags=flags)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        self.assertEqual(reader.up_channels[0].channel_type, CHANNEL_TYPE_FLOAT32)
        self.assertEqual(reader.up_channels[0].channel_type_name, "float32")
        self.assertTrue(reader.up_channels[0].graphable)

    def test_poll_updates_channel_flags(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        up_buf, _ = build_control_block(tcl, cb_addr, up_buf_size=64)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        flags = CHANNEL_TYPE_FLOAT32 << CHANNEL_TYPE_SHIFT
        tcl.write_u32(reader.up_channels[0].desc_addr + CH_OFF_FLAGS, flags)
        tcl._write_raw(up_buf, b"\x00\x00\x20\x41")
        tcl.write_u32(reader.up_channels[0].desc_addr + CH_OFF_WROFF, 4)

        reader.poll_up(lambda ch, data: None)

        self.assertEqual(reader.up_channels[0].channel_type, CHANNEL_TYPE_FLOAT32)

    def test_read_contiguous(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        up_buf, _ = build_control_block(tcl, cb_addr, up_buf_size=64)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        # Firmware writes "Hello" to up buffer
        tcl._write_raw(up_buf, b"Hello")
        tcl.write_u32(reader.up_channels[0].desc_addr + CH_OFF_WROFF, 5)

        received = []
        def on_data(ch, data):
            received.append((ch, data))

        total = reader.poll_up(on_data)
        self.assertEqual(total, 5)
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0], (0, b"Hello"))

    def test_read_wrap(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        up_buf, _ = build_control_block(tcl, cb_addr, up_buf_size=8)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        # Simulate wrap: rdOff=6, wrOff=2, buf size=8
        # Data at offset 6,7 = "AB", data at offset 0,1 = "CD"
        tcl._write_raw(up_buf + 6, b"AB")
        tcl._write_raw(up_buf, b"CD")
        tcl.write_u32(reader.up_channels[0].desc_addr + CH_OFF_RDOFF, 6)
        tcl.write_u32(reader.up_channels[0].desc_addr + CH_OFF_WROFF, 2)

        received = []
        reader.poll_up(lambda ch, data: received.append((ch, data)))

        self.assertEqual(len(received), 1)
        self.assertEqual(received[0][1], b"ABCD")

    def test_read_empty(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        build_control_block(tcl, cb_addr)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        total = reader.poll_up()
        self.assertEqual(total, 0)


class TestWriteDown(unittest.TestCase):
    def test_write_contiguous(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        _, down_buf = build_control_block(tcl, cb_addr, down_buf_size=64)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        written = reader.write_down(0, b"Test")
        self.assertEqual(written, 4)

        # Verify data in buffer
        data = tcl.read_bytes(down_buf, 4)
        self.assertEqual(data, b"Test")

    def test_write_full_buffer(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        _, down_buf = build_control_block(tcl, cb_addr, down_buf_size=8)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        # Buffer size=8, free space=7 (size-1)
        written = reader.write_down(0, b"12345678")
        self.assertEqual(written, 7)

    def test_write_empty_data(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        build_control_block(tcl, cb_addr)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        written = reader.write_down(0, b"")
        self.assertEqual(written, 0)

    def test_write_invalid_channel(self):
        tcl = FakeOpenOcdTcl()
        cb_addr = 0x20000100
        build_control_block(tcl, cb_addr)

        reader = ProbeStreamReader(tcl)
        reader.attach(cb_addr)

        written = reader.write_down(5, b"Test")
        self.assertEqual(written, 0)


if __name__ == "__main__":
    unittest.main()
