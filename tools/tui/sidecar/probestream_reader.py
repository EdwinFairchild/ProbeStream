"""Python port of ProbeStreamReader from host/ProbeStreamReader.cpp.

Uses OpenOcdTcl for memory access instead of the C++ IProbeMemory interface.
"""

import struct
from dataclasses import dataclass, field
from typing import Callable, Optional

try:
    from .openocd_tcl import OpenOcdTcl
except ImportError:
    from openocd_tcl import OpenOcdTcl

MAGIC = b"ProbeStreamV1\x00\x00\x00"
MAGIC_LEN = 16

OFF_MAGIC = 0
OFF_NUM_UP = 16
OFF_NUM_DOWN = 20
OFF_MAX_UP = 24
OFF_MAX_DOWN = 28
HEADER_SIZE = 32

CH_OFF_PBUFFER = 0
CH_OFF_SIZE = 4
CH_OFF_WROFF = 8
CH_OFF_RDOFF = 12
CH_OFF_FLAGS = 16
CH_DESC_SIZE = 20


def up_channel_offset(index: int) -> int:
    return HEADER_SIZE + index * CH_DESC_SIZE


def down_channel_offset(max_up: int, index: int) -> int:
    return HEADER_SIZE + max_up * CH_DESC_SIZE + index * CH_DESC_SIZE


@dataclass
class ChannelState:
    p_buffer: int = 0
    size: int = 0
    wr_off: int = 0
    rd_off: int = 0
    flags: int = 0
    desc_addr: int = 0


DataCallback = Callable[[int, bytes], None]


class ProbeStreamReader:
    def __init__(self, tcl: OpenOcdTcl, read_mode: str = "auto"):
        self.tcl = tcl
        self.read_mode = read_mode
        self.cb_addr: int = 0
        self.num_up: int = 0
        self.num_down: int = 0
        self.max_up: int = 0
        self.max_down: int = 0
        self.up_channels: list[ChannelState] = []
        self.down_channels: list[ChannelState] = []

    @property
    def attached(self) -> bool:
        return self.cb_addr != 0

    def discover(self, ram_start: int, ram_size: int, scan_chunk_size: int = 1024) -> bool:
        for offset in range(0, ram_size, scan_chunk_size):
            addr = ram_start + offset
            read_len = min(scan_chunk_size, ram_size - offset)
            try:
                data = self.tcl.read_bytes(addr, read_len, self.read_mode)
            except Exception:
                continue
            idx = data.find(MAGIC)
            if idx >= 0:
                self.cb_addr = addr + idx
                return self._read_control_block()
        return False

    def attach(self, cb_addr: int) -> bool:
        try:
            magic = self.tcl.read_bytes(cb_addr, MAGIC_LEN, self.read_mode)
        except Exception:
            return False
        if magic != MAGIC:
            return False
        self.cb_addr = cb_addr
        return self._read_control_block()

    def _read_control_block(self) -> bool:
        self.num_up = self.tcl.read_u32(self.cb_addr + OFF_NUM_UP)
        self.num_down = self.tcl.read_u32(self.cb_addr + OFF_NUM_DOWN)
        self.max_up = self.tcl.read_u32(self.cb_addr + OFF_MAX_UP)
        self.max_down = self.tcl.read_u32(self.cb_addr + OFF_MAX_DOWN)

        if self.num_up == 0 or self.num_up > 64 or self.num_down > 64:
            return False
        if self.max_up < self.num_up or self.max_down < self.num_down:
            return False

        self.up_channels = []
        for i in range(self.num_up):
            ch = ChannelState()
            ch.desc_addr = self.cb_addr + up_channel_offset(i)
            ch.p_buffer = self.tcl.read_u32(ch.desc_addr + CH_OFF_PBUFFER)
            ch.size = self.tcl.read_u32(ch.desc_addr + CH_OFF_SIZE)
            ch.wr_off = 0
            ch.rd_off = 0
            ch.flags = self.tcl.read_u32(ch.desc_addr + CH_OFF_FLAGS)
            self.up_channels.append(ch)

        self.down_channels = []
        for i in range(self.num_down):
            ch = ChannelState()
            ch.desc_addr = self.cb_addr + down_channel_offset(self.max_up, i)
            ch.p_buffer = self.tcl.read_u32(ch.desc_addr + CH_OFF_PBUFFER)
            ch.size = self.tcl.read_u32(ch.desc_addr + CH_OFF_SIZE)
            ch.wr_off = 0
            ch.rd_off = 0
            ch.flags = self.tcl.read_u32(ch.desc_addr + CH_OFF_FLAGS)
            self.down_channels.append(ch)

        return True

    def poll_up(self, cb: Optional[DataCallback] = None) -> int:
        total_read = 0
        for i, ch in enumerate(self.up_channels):
            # One round-trip for both offsets (firmware writes wr, we own rd,
            # so a stale read here is harmless: we just defer leftover bytes
            # to the next poll).
            offsets = self.tcl.mdw_n(ch.desc_addr + CH_OFF_WROFF, 2)
            if len(offsets) < 2:
                continue
            wr_off, rd_off = offsets[0], offsets[1]

            if wr_off == rd_off:
                continue

            if wr_off >= rd_off:
                avail = wr_off - rd_off
            else:
                avail = ch.size - (rd_off - wr_off)

            if avail == 0 or avail >= ch.size:
                continue

            if wr_off > rd_off:
                data = self.tcl.read_bytes(
                    ch.p_buffer + rd_off, avail, self.read_mode
                )
            else:
                part1 = self.tcl.read_bytes(
                    ch.p_buffer + rd_off, ch.size - rd_off, self.read_mode
                )
                part2 = b""
                if wr_off > 0:
                    part2 = self.tcl.read_bytes(
                        ch.p_buffer, wr_off, self.read_mode
                    )
                data = part1 + part2

            # Advance rd_off on target. Single-writer (us) for rd_off, so no
            # lock needed across the read+ack pair.
            self.tcl.write_u32(ch.desc_addr + CH_OFF_RDOFF, wr_off)
            ch.rd_off = wr_off
            ch.wr_off = wr_off

            if data and cb:
                cb(i, data)

            total_read += len(data)

        return total_read

    def write_down(self, channel: int, data: bytes) -> int:
        if channel >= self.num_down or len(data) == 0:
            return 0

        ch = self.down_channels[channel]
        # Single round-trip for both offsets.
        offsets = self.tcl.mdw_n(ch.desc_addr + CH_OFF_WROFF, 2)
        if len(offsets) < 2:
            return 0
        wr_off, rd_off = offsets[0], offsets[1]

        if rd_off > wr_off:
            free = rd_off - wr_off - 1
        else:
            free = (ch.size - 1) - (wr_off - rd_off)

        if free == 0:
            return 0

        to_write = min(len(data), free)

        if wr_off + to_write <= ch.size:
            first_part = min(to_write, ch.size - wr_off)
            self.tcl.write_bytes(ch.p_buffer + wr_off, data[:first_part])
            written = first_part
            new_wr = wr_off + first_part
            if new_wr >= ch.size:
                new_wr = 0
            if written < to_write:
                second_part = to_write - written
                self.tcl.write_bytes(ch.p_buffer, data[written:written + second_part])
                written += second_part
                new_wr = second_part
        else:
            part1 = ch.size - wr_off
            self.tcl.write_bytes(ch.p_buffer + wr_off, data[:part1])
            part2 = to_write - part1
            if part2 > 0:
                self.tcl.write_bytes(ch.p_buffer, data[part1:part1 + part2])
            written = to_write
            new_wr = part2

        self.tcl.write_u32(ch.desc_addr + CH_OFF_WROFF, new_wr)
        ch.wr_off = new_wr
        return written
