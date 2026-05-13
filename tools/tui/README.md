# ProbeStream TUI

Terminal UI for real-time debug streaming over OpenOCD using the ProbeStream protocol.

## Prerequisites

- **Bun** ≥ 1.3 — runtime and package manager (replaces Node/npm)
- **Python** ≥ 3.10 — stdlib only, no pip packages required
- **OpenOCD** — STM32CubeIDE ships one, or install separately
- **A terminal** with kitty keyboard protocol support recommended (kitty, WezTerm, ghostty, Alacritty ≥ 0.14). Falls back gracefully on others.
- **xclip** (Linux only) — for clipboard support

## Install from Source

### 1. Install Bun

**macOS / Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex"
```

Restart your terminal after installing so `bun` is on your PATH.  
Installs to `~/.bun/bin/bun` (Unix) or `%USERPROFILE%\.bun\bin\bun.exe` (Windows).

### 2. Clone and install dependencies

```bash
git clone <repo-url>
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

Produces a standalone binary + sidecar in `../../probestream-tui-dist/`.

## Quick Start

1. Press `/` to open the command prompt
2. `/discover` — list attached debug probes
3. `/probes` — select a probe serial when more than one is attached
4. `/settings` — configure OpenOCD path, interface, target, RAM range
5. `/openocd start` — spawn OpenOCD for the selected probe
6. `/scan` — scan target RAM for the ProbeStream control block
7. `/start` — begin streaming
8. `/stream` — view up-channel data
9. `/terminal enter` — type commands to the down-channel

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

### Terminal
`/terminal enter [channel]`, `/terminal exit`, `/send <text>`, `/send-hex <hex>`

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

Settings persist to `~/.config/probestream-tui/settings.json`.

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
