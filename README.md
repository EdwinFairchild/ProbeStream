# ProbeStream

[![CI](https://github.com/EdwinFairchild/ProbeStream/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/EdwinFairchild/ProbeStream/actions/workflows/ci.yml) [![Release](https://github.com/EdwinFairchild/ProbeStream/actions/workflows/release.yml/badge.svg)](https://github.com/EdwinFairchild/ProbeStream/actions/workflows/release.yml) [![Latest release](https://img.shields.io/github/v/release/EdwinFairchild/ProbeStream?include_prereleases&sort=semver)](https://github.com/EdwinFairchild/ProbeStream/releases) [![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-blue)](https://github.com/EdwinFairchild/ProbeStream/releases) [![License](https://img.shields.io/github/license/EdwinFairchild/ProbeStream)](LICENSE)

![ProbeStream demo](PS.gif)

ProbeStream is a clean-room, RTT-style bidirectional transport between a microcontroller and a host PC over the existing SWD/JTAG debug link. The MCU writes log/telemetry data into a ring buffer in its own RAM; the host reads the buffer through the debugger without ever halting the CPU. The host can also write to a second ring buffer to deliver commands back to the firmware.

If you've used SEGGER RTT, this is the same idea : a free, header-only-ish C library on the target plus a small C++/Python reader on the host. It works with any debug probe that can do non-intrusive memory reads (ST-Link, J-Link, CMSIS-DAP, ULINK, …) via OpenOCD or pyOCD.

## Quick References

- [TUI Quick Start](docs/TUI-QuickStart.md) — download-first setup, settings, OpenOCD, probe selection, scan/attach, and streaming
- [TUI README](tools/tui/README.md) — release downloads, source build instructions, commands, settings, architecture, tests, and limitations
- [Target C API](docs/API.md) — firmware-side `PS_Init`, write/printf, channel, and down-channel APIs
- [Wire Protocol](docs/wire-protocol.md) — control block and ring-buffer layout used by host tools
- [TUI source](tools/tui/) — OpenTUI frontend, Python sidecar, scripts, and tests



## Why ProbeStream
- **No JLink required** to get RTT style logging.
- **No extra pins or peripherals.** Uses the SWD link you already use for flashing.
- **No target-side ISR or DMA.** Just memcpy into a RAM buffer.
- **Non-halting.** The host reads memory while the CPU runs at full speed.
- **Bidirectional.** Up-channels (target → host) for logs/telemetry; down-channels (host → target) for runtime commands.
- **Easy to compile-out.** Set `PS_ENABLED 0` and every call disappears : zero footprint in release builds.


## Measured performance

These numbers come from running the stress-test firmware in `tests/smoke_nucleo_u385/` and `tests/smoke_nucleo_g474/`, with the host driving everything through a stock OpenOCD over the on-board ST-Link V3. Results depend heavily on the chip, debug-probe driver, SWD clock, and how the host reads memory : the two boards below show how much spread is possible to imply how much performance really depends on MCU/debugger. Treat these as data points, not advertised limits.

### Nucleo-G474RE 
##### (STM32G474, Cortex-M4 @ 170 MHz, 2 MHz SWD, bulk `read_memory`)

| Phase | Result |
|---|---|
| Up-channel sustained throughput (target → host) | **~104 KB/s** |
| Up-channel offset-only poll rate | **~1,108 KB/s, 1,180 polls/s** |
| Down-channel write throughput (host → target) | **~7.6 KB/s** |
| Round-trip latency (host write → target echo → host read, 5 B payload) | **3.1 ms avg / 3.7 ms p95** |
| Data integrity over 10 s of continuous streaming | **43,614 messages**, **0 out-of-order**, **0 corruption** |

### Nucleo-U385RG-Q 
##### (STM32U385, Cortex-M33 @ 96 MHz, 500 kHz SWD, per-word `mdw`)

| Phase | Result |
|---|---|
| Up-channel sustained throughput (target → host) | **~25 KB/s** |
| Up-channel offset-only poll rate | **~608 KB/s, 520 polls/s** |
| Down-channel write throughput (host → target) | **~3.3 KB/s** |
| Round-trip latency (5 B payload) | **2.0 ms avg / 2.1 ms p95** |
| Data integrity over 10 s | 31,500 messages, 1 read-side race, no corruption |

### Why the two boards land so far apart

ProbeStream itself is the same library on both targets. The MCU is not the bottleneck either : in both cases the firmware fills its ring buffer many times faster than the host can drain it. The numbers above are set almost entirely by **how OpenOCD is allowed to talk to the chip over SWD**, and that is decided by the debug-probe driver, not by ProbeStream.

On the U3, OpenOCD falls back to ST's `hla_swd` driver. `hla_swd` is a "high-level" wrapper where the ST-Link firmware owns the SWD transactions, so OpenOCD can only ask for things through ST's protocol. In practice this means two hard ceilings on the U3:

- The SWD clock is pinned at 500 kHz regardless of `adapter speed`.
- Bulk memory reads on a running CPU are not exposed, so the host has to read the ring buffer one 32-bit word at a time.

On the G4, the same physical ST-Link talks through a path that runs at 2 MHz and supports a single bulk `read_memory` call covering the whole ring in one transaction. That's the ~4× throughput difference, and it's why latency vs. throughput don't move together between the two boards.



## Repository layout

```
ProbeStream/
├── README.md               ← this file
├── docs/
│   ├── API.md                target-side C API reference
│   └── wire-protocol.md      on-wire control block and ring buffer layout
├── target/                 ← C library that links into your MCU firmware
│   ├── probestream.h         public API
│   ├── probestream.c         implementation
│   └── probestream_conf.h    compile-time configuration
├── host/                   ← C++ host library
│   ├── ProbeStreamReader.h   reader API, abstract memory backend
│   ├── ProbeStreamReader.cpp
│   └── ProbeStreamProtocol.h shared constants : layout of the control block
├── tests/
│   ├── smoke_nucleo_u385/    STM32U3 firmware + host benchmark
│   ├── smoke_nucleo_g474/    STM32G4 firmware + host benchmark
│   └── test_reader.cpp       host-library unit tests (no hardware needed)
└── tools/
    └── ps_terminal.py        interactive TUI: live up-channel viewer + input
```

## Getting started

### On the target

1. Drop `target/probestream.c` and `target/probestream.h` into your project (and optionally provide your own `probestream_conf.h` to override defaults).
2. Reserve a RAM buffer and pass it to `PS_Init` once at startup:
   ```c
   static uint8_t ps_buffer[2048] __attribute__((aligned(4)));

   PS_Config_t cfg = {
       .pBuffer         = ps_buffer,
       .bufferSize      = sizeof(ps_buffer),
       .numUpChannels   = 1,
       .numDownChannels = 1,
       .defaultMode     = PS_MODE_TRIM,
   };
   PS_Init(&cfg);
   ```
3. Use it like printf:
   ```c
   PS_Printf(0, "tick %lu\n", HAL_GetTick());
   ```
4. Optionally drain incoming bytes from the host:
   ```c
   uint8_t cmd[64];
   uint32_t n = PS_Read(0, cmd, sizeof(cmd));
   ```

Full API in [docs/API.md](docs/API.md).

### On the host

For the terminal UI, start by downloading the latest Windows or Linux bundle from the [ProbeStream releases page](https://github.com/EdwinFairchild/ProbeStream/releases/latest). Release builds include the Bun-compiled TUI binary, so you do not need Bun unless you are developing from source.

Then follow the [TUI quick-start guide](docs/TUI-QuickStart.md). It covers setting OpenOCD paths/configs, selecting a probe, scanning for the ProbeStream control block, and starting the live stream.

Legacy Python terminal path:

```bash
./tools/run_terminal.sh --launch-openocd
```

It will spawn OpenOCD, find the control block by scanning RAM for the magic, and give you a scrolling view of up-channel 0 plus an input box that sends to down-channel 0.

## Running the benchmarks

To reproduce the numbers above:

```bash
# STM32U3
cd tests/smoke_nucleo_u385
cmake -DCMAKE_BUILD_TYPE=Debug -DSTRESS_TEST=ON -B build_stress -G Ninja
ninja -C build_stress
python3 benchmark_inline.py     # flashes, runs, prints results

# STM32G4
cd tests/smoke_nucleo_g474
cmake -DCMAKE_BUILD_TYPE=Debug -DSTRESS_TEST=ON -B build_stress -G Ninja
ninja -C build_stress
# Flash, then start OpenOCD in another shell, then:
PS_USE_EXISTING_OCD=1 python3 benchmark_g4.py
```

## License

TBD.
