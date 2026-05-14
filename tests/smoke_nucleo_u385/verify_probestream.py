#!/usr/bin/env python3
"""
ProbeStream smoke-test verifier.

Flashes PS_Smoke.elf to a Nucleo U385 via OpenOCD, then scans target RAM
for the ProbeStream control block, reads the up-channel ring buffer,
and checks that the firmware is writing "ProbeStream smoke N" messages.
"""

import socket
import struct
import subprocess
import sys
import time
import os

OPENOCD_BIN = "/opt/st/stm32cubeide_1.18.1/plugins/com.st.stm32cube.ide.mcu.externaltools.openocd.linux64_2.4.100.202501161620/tools/bin/openocd"
OPENOCD_SCRIPTS = "/media/eddie/Engineering/Projects/ViewAlyzer_Root/external/OpenOCD/tcl"
STM32_PROGRAMMER = "/opt/st/stm32cubeclt_1.21.0/STM32CubeProgrammer/bin/STM32_Programmer_CLI"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ELF_PATH = os.path.join(SCRIPT_DIR, "build/Debug/PS_Smoke.elf")
HEX_PATH = os.path.join(SCRIPT_DIR, "build/Debug/PS_Smoke.hex")

TCL_PORT = 6666
MAGIC = b"ProbeStream\x00\x00\x00\x00\x00"
RAM_START = 0x20000000
RAM_SIZE  = 192 * 1024  # 192 KB


class OpenOcdTcl:
    """Minimal OpenOCD TCL-RPC client."""

    def __init__(self, host="localhost", port=TCL_PORT):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((host, port))
        self.sock.settimeout(5.0)

    def send(self, cmd: str) -> str:
        data = cmd.encode("ascii") + b"\x1a"  # Ctrl-Z terminator
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

    def read_memory(self, addr: int, count: int) -> bytes:
        """Read `count` bytes from target memory."""
        # read_memory returns hex pairs; we read 8-bit width
        result = self.send(f"read_memory 0x{addr:08x} 8 {count}")
        parts = result.strip().split()
        return bytes(int(x, 16) for x in parts)

    def read_u32(self, addr: int) -> int:
        data = self.read_memory(addr, 4)
        return struct.unpack("<I", data)[0]

    def close(self):
        self.sock.close()


def find_control_block(tcl: OpenOcdTcl) -> int | None:
    """Scan RAM for the ProbeStream magic in 1KB chunks."""
    print(f"Scanning RAM 0x{RAM_START:08X}..0x{RAM_START + RAM_SIZE:08X} for magic...")
    chunk_size = 1024
    for offset in range(0, RAM_SIZE, chunk_size):
        addr = RAM_START + offset
        try:
            data = tcl.read_memory(addr, chunk_size)
        except Exception:
            continue
        idx = data.find(MAGIC)
        if idx >= 0:
            cb_addr = addr + idx
            print(f"  Found magic at 0x{cb_addr:08X}")
            return cb_addr
    return None


def read_up_channel_data(tcl: OpenOcdTcl, cb_addr: int) -> str:
    """Read data from up-channel 0."""
    # Control block layout:
    #   magic[16] + numUp(4) + numDown(4) + maxUp(4) + maxDown(4) = 32 bytes header
    #   aUp[0]: pBuffer(4) + size(4) + wrOff(4) + rdOff(4) + flags(4) = 20 bytes
    num_up = tcl.read_u32(cb_addr + 16)
    num_down = tcl.read_u32(cb_addr + 20)
    max_up = tcl.read_u32(cb_addr + 24)
    max_down = tcl.read_u32(cb_addr + 28)
    print(f"  numUp={num_up}, numDown={num_down}, maxUp={max_up}, maxDown={max_down}")

    ch0_base = cb_addr + 32  # first up-channel descriptor
    p_buffer = tcl.read_u32(ch0_base + 0)
    buf_size = tcl.read_u32(ch0_base + 4)
    wr_off   = tcl.read_u32(ch0_base + 8)
    rd_off   = tcl.read_u32(ch0_base + 12)

    print(f"  Up[0]: pBuffer=0x{p_buffer:08X} size={buf_size} wrOff={wr_off} rdOff={rd_off}")

    if wr_off == rd_off:
        return ""

    # Calculate how many bytes are available
    if wr_off >= rd_off:
        avail = wr_off - rd_off
    else:
        avail = buf_size - (rd_off - wr_off)

    if avail == 0 or avail > buf_size:
        return ""

    # Read data from ring buffer (may wrap)
    if wr_off > rd_off:
        data = tcl.read_memory(p_buffer + rd_off, avail)
    else:
        part1 = tcl.read_memory(p_buffer + rd_off, buf_size - rd_off)
        part2 = tcl.read_memory(p_buffer, wr_off)
        data = part1 + part2

    # Advance rdOff on target so the firmware doesn't stall
    # (write new rdOff = wrOff)
    tcl.send(f"write_memory 0x{ch0_base + 12:08x} 32 {{0x{wr_off:08x}}}")

    return data.decode("ascii", errors="replace")


def flash_firmware():
    """Flash using STM32_Programmer_CLI, then reset."""
    # Generate hex from ELF
    print(f"Converting {ELF_PATH} to hex...")
    subprocess.run(
        ["arm-none-eabi-objcopy", "-O", "ihex", ELF_PATH, HEX_PATH],
        check=True,
    )
    print(f"Flashing {HEX_PATH} via STM32_Programmer_CLI...")
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
    print("  Flash + verify + reset OK")
    return True


def main():
    # 1) Flash
    if not flash_firmware():
        return 1

    # 2) Let firmware run
    print("Letting firmware run for 3 seconds...")
    time.sleep(3)

    # 3) Start OpenOCD for memory reading
    print("Starting OpenOCD for memory inspection...")
    ocd_proc = subprocess.Popen(
        [
            OPENOCD_BIN,
            "-s", OPENOCD_SCRIPTS,
            "-f", "interface/stlink.cfg",
            "-f", "target/stm32u3x.cfg",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    time.sleep(2)

    if ocd_proc.poll() is not None:
        stderr = ocd_proc.stderr.read().decode()
        print(f"OpenOCD failed to start:\n{stderr}")
        return 1

    try:
        tcl = OpenOcdTcl()

        # 4) Halt the core
        tcl.send("halt")
        time.sleep(0.2)

        # 5) Find control block
        cb_addr = find_control_block(tcl)
        if cb_addr is None:
            print("FAIL: Could not find ProbeStream control block in RAM!")
            return 1

        # 6) Read data from up-channel 0
        data = read_up_channel_data(tcl, cb_addr)
        print(f"\n--- Data from up-channel 0 ---")
        print(data if data else "(empty)")
        print("--- End ---\n")

        # 7) Verify
        if "ProbeStream smoke" in data:
            lines = [l for l in data.strip().split("\n") if l.startswith("ProbeStream smoke")]
            print(f"PASS: Found {len(lines)} ProbeStream messages")
            for line in lines[:5]:
                print(f"  {line}")
            if len(lines) > 5:
                print(f"  ... and {len(lines) - 5} more")
            return 0
        else:
            print("FAIL: No 'ProbeStream smoke' messages found in ring buffer")
            return 1

    finally:
        try:
            tcl.send("resume")
            tcl.close()
        except Exception:
            pass
        ocd_proc.terminate()
        ocd_proc.wait(timeout=5)
        print("OpenOCD stopped.")


if __name__ == "__main__":
    sys.exit(main())
