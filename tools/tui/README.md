# ProbeStream TUI

Terminal UI for real-time debug streaming over OpenOCD using the ProbeStream protocol.

## Quick References

- [TUI Quick Start](../../docs/TUI-QuickStart.md) — first-run setup, settings, OpenOCD, probe selection, scan/attach, and streaming
- [ProbeStream README](../../README.md) — project overview, target integration, performance notes, and repository layout
- [Target C API](../../docs/API.md) — firmware-side `PS_Init`, write/printf, channel, and down-channel APIs
- [Wire Protocol](../../docs/wire-protocol.md) — control block and ring-buffer layout used by host tools
- [TUI Commands](#commands) — slash command reference for this interface
- [TUI Settings](#settings) — persisted settings used by the sidecar and OpenOCD launcher

## Prerequisites

- **Python** ≥ 3.10 — stdlib only, no pip packages required
- **OpenOCD** — STM32CubeIDE ships one, or install separately
- **A terminal** with kitty keyboard protocol support recommended (kitty, WezTerm, ghostty, Alacritty ≥ 0.14). Falls back gracefully on others.
- **xclip** (Linux only) — for clipboard support

Release builds include the Bun-compiled TUI binary, so users do not need Bun unless they are building from source.

## Download a Release

Download the latest platform bundle from the [ProbeStream releases page](https://github.com/EdwinFairchild/ProbeStream/releases/latest):

- Windows: `probestream-tui-<version>-windows-x64.zip`
- Linux: `probestream-tui-<version>-linux-x64.tar.gz`

Extract the archive, then run the TUI from the extracted directory:

```powershell
# Windows PowerShell
.\probestream-tui.exe
```

```bash
# Linux
./probestream-tui
```

The sidecar starts automatically from the bundled `sidecar` directory. Install OpenOCD separately and keep Python 3.10+ available on PATH.

## Install from Source

Use this path only if you want to develop the TUI or build your own binary.

### 1. Install dependencies

After cloning the repository, run the cross-platform installer from the repository root:

```bash
git clone <repo-url>
cd <repo>
python3 tools/tui/scripts/install-deps.py
```

On Windows, use `py` or `python` if `python3` is not available:

```powershell
py tools\tui\scripts\install-deps.py
```

The installer checks for Bun, installs it if missing, repairs the Bun PATH entry for future terminals, and runs `bun install`.

### 2. Install manually if preferred

```bash
cd <repo>/tools/tui

bun install
```

No Python packages to install — the sidecar uses only the standard library.

## Run (development)

```bash
bun run dev
```

This starts the sidecar automatically and launches the TUI. The sidecar listens on `http://127.0.0.1:17900` by default.

To run the sidecar separately (for debugging):

```bash
# Terminal 1: sidecar
./scripts/sidecar.sh

# Terminal 2: TUI (will detect the running sidecar)
bun run dev
```

## Build (distribution)

```bash
bun run dist
```

Produces a standalone binary + sidecar in `../../probestream-tui-dist/`. On Windows the binary is `probestream-tui.exe`; on Linux it is `probestream-tui`.

## Quick Start

For a complete first-run walkthrough, including settings, OpenOCD setup, probe selection, attach/scan, and stream startup, see [../../docs/TUI-QuickStart.md](../../docs/TUI-QuickStart.md).

1. Press `/` to open the command prompt
2. `/discover` — list attached debug probes
3. `/probes` — select a probe serial when more than one is attached
4. `/settings` — configure OpenOCD path, interface, target, RAM range
5. `/openocd start` — spawn OpenOCD for the selected probe
6. `/scan` — scan target RAM for the ProbeStream control block
7. `/stream-start` — begin streaming without re-running OpenOCD/scan
8. `/stream` — view up-channel data
9. `/terminal 0` — type commands to down-channel 0

## Key Bindings

| Key | Action |
|-----|--------|
| `/` | Open command prompt |
| `?` | Page-specific help |
| `Ctrl+←/→` | Switch pages (alt-tab style) |
| `Ctrl+C` | Quit |
| `Esc` | Close modal / unfocus prompt |
| `Enter` | Submit command / close switcher |

## Pages

- **Splash** — status overview, detected probes, quick start action
- **Probes** — debug probe list, selected serial, OpenOCD session details
- **Stream** — live up-channel data viewer (raw/hex/ascii/line modes)
- **Terminal** — bidirectional down-channel communication
- **Settings** — all configuration options
- **Log** — command replies and backend messages, excluding stream payloads

## Commands

### Navigation
`/splash`, `/probes`, `/stream`, `/terminal`, `/settings`, `/log`, `/help`, `/quit`

### OpenOCD
`/openocd start`, `/openocd connect`, `/openocd stop`

### Probes and ProbeStream
`/discover`, `/scan`, `/attach <addr>`

### Streaming
`/start`, `/stop`, `/channel <n>`, `/mode raw|hex|ascii|line`, `/clear`

Channels carry a type tag (`raw`, `text`, `ascii-number`, `int32`, `uint32`, `float32`, `float64`) set by the firmware via `PS_WriteInt`/`PS_WriteUInt`/`PS_WriteFloat`/`PS_WriteDouble` or `PS_SetChannelType`. The Stream page decodes typed numeric channels and enables graphing and running stats on them automatically. See [Typed numeric channels](../../docs/API.md#typed-numeric-channels) and the [graphing notes in the TUI Quick Start](../../docs/TUI-QuickStart.md).

### Terminal
`/terminal [channel]`, `/terminal exit`, `/send <text>`, `/send-hex <hex>`

### Capture
`/capture on|off|path <file>|format raw|text|jsonl`

### Settings
`/set <key> <value>`

## Settings

Key settings (configurable via `/settings` page or `/set`):

| Setting | Default | Description |
|---------|---------|-------------|
| `themeName` | `probe` | UI theme (probe, material, github) |
| `openocdPath` | `openocd` | Path to OpenOCD binary |
| `interfaceConfig` | `interface/stlink.cfg` | OpenOCD interface config |
| `targetConfig` | (empty) | OpenOCD target config |
| `adapterSerial` | (empty) | Debug probe serial selected from `/probes` |
| `tclPort` | `6666` | OpenOCD TCL-RPC port |
| `ramStart` | `0x20000000` | Target RAM start address |
| `ramSize` | `196608` | RAM scan size in bytes |
| `readMode` | `auto` | Memory read strategy (auto/bulk/mdw) |
| `pollMs` | `25` | Stream polling interval |
| `captureFormat` | `raw` | Capture file format |

Settings persist to `~/.config/probestream-tui/settings.json` on Linux/macOS, or `%USERPROFILE%\.config\probestream-tui\settings.json` on Windows.

## Architecture

```
┌────────────────────┐     HTTP/SSE      ┌──────────────────┐
│  Bun/OpenTUI TUI   │ ←───────────────→ │  Python Sidecar  │
│  (React terminal)  │   :17900          │  (stdlib HTTP)   │
└────────────────────┘                    └───────┬──────────┘
                                                  │ TCL-RPC
                                                  ▼
                                          ┌──────────────────┐
                                          │     OpenOCD      │
                                          │   (SWD/JTAG)     │
                                          └───────┬──────────┘
                                                  │
                                                  ▼
                                          ┌──────────────────┐
                                          │  Target MCU      │
                                          │  (ProbeStream)   │
                                          └──────────────────┘
```

## Tests

```bash
# TypeScript tests
bun test

# Python sidecar tests (no hardware required)
python3 sidecar/test_probestream_reader.py -v

# TypeScript typecheck
bun run typecheck
```

## Known Limitations

- Debug probe enumeration is best-effort via `st-info --probe` or `STM32_Programmer_CLI -l`
- Single session at a time in v1
- `read_memory` (bulk) may not work on all targets while running — falls back to `mdw`
- No replay tooling yet for captured `.jsonl` files
