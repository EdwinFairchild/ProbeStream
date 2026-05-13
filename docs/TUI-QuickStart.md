# ProbeStream TUI Quick Start


## 1. Get or build The TUI
### Option 1. Download the TUI prebuilt binary

Download the latest platform bundle from the [ProbeStream releases page](https://github.com/EdwinFairchild/ProbeStream/releases/latest):

- Windows: `probestream-tui-<version>-windows-x64.zip`
- Linux: `probestream-tui-<version>-linux-x64.tar.gz`

Extract it somewhere convenient. Release builds include the Bun-compiled TUI binary, so you do not need to install Bun.

> [!WARNING]
> Windows may warn that the downloaded binary does not have a code-signing certificate. If that bothers you, build it yourself from source using Option 2 below.

You still need:

- Python 3.10+ on PATH for the bundled sidecar
- OpenOCD installed or available through STM32CubeIDE
- A terminal with good keyboard support, such as Windows Terminal, WezTerm, kitty, ghostty, or Alacritty

### Option 2. Install dependencies and build or run from source

If you are modifying the TUI or building your own binary, clone the repository and run the dependency installer from the repository root:

```bash
# Linux / macOS
python3 tools/tui/scripts/install-deps.py
```

On Windows PowerShell:

```powershell
py tools\tui\scripts\install-deps.py
```

The installer checks for Bun, installs it if needed, repairs the Bun PATH entry when the installer did not stick, and runs `bun install` for the TUI package.

## 2. Start the TUI

From an extracted release bundle:

```powershell
# Windows PowerShell
.\probestream-tui.exe
```

```bash
# Linux
./probestream-tui
```

From a source checkout:

```bash
cd tools/tui
bun run dev
```

If Bun is installed but your current shell still cannot find it, use:

```bash
~/.bun/bin/bun run dev
```

The TUI starts its Python sidecar automatically. The sidecar talks to OpenOCD over TCL-RPC and the TUI talks to the sidecar over HTTP/SSE on `127.0.0.1:17900`.

## 3. Configure Settings

Open the command prompt with `/`, then run:

```text
/settings
```

Set the fields that tell the sidecar how to start or connect to OpenOCD:

| Setting | What to put here |
|---|---|
| `openocdPath` | Path to the OpenOCD executable, or just `openocd` if it is on PATH |
| `openocdScriptsPath` | Optional OpenOCD scripts directory, useful for STM32CubeIDE installs |
| `interfaceConfig` | Debug probe config, for example `interface/stlink.cfg` |
| `targetConfig` | Target config, for example `target/stm32u3x.cfg` |
| `adapterSerial` | Optional probe serial; useful when more than one probe is attached |
| `ramStart` | Start of target RAM to scan, usually `0x20000000` on STM32 |
| `ramSize` | Number of RAM bytes to scan for the ProbeStream control block |
| `controlBlockAddr` | Optional fixed control block address if you already know it |
| `graphWindowSize` | Number of numeric samples retained in each graph window |

Settings page keys:

```text
↑/↓            Select setting
Space          Toggle/cycle, or edit string values
Tab / Enter    Edit selected value
Enter          Save while editing
Esc            Cancel edit
Ctrl+U         Clear current edit buffer
```

Settings persist to `~/.config/probestream-tui/settings.json` on Linux/macOS, or `%USERPROFILE%\.config\probestream-tui\settings.json` on Windows.

> [!TIP]
> Once `openocdPath`, `openocdScriptsPath`, `interfaceConfig`, and `targetConfig` are set, and your hardware is connected, you can usually skip the manual OpenOCD/scan/stream steps below. Go to the Splash page and press `Enter` to use auto-start mode.

## 4. Select a Probe

If only one debug probe is connected, you can often skip this. If several are connected, choose the one ProbeStream should use:

```text
/probes
```

Keys:

```text
r              Refresh probe discovery
↑/↓            Select a probe
Space / Enter  Save the selected serial to adapterSerial
```

You can also refresh probes directly from the prompt:

```text
/discover
```

## 5. Start or Connect OpenOCD

To let the TUI spawn OpenOCD using your saved settings:

```text
/openocd start
```

If OpenOCD is already running elsewhere, connect to it instead:

```text
/openocd connect
```

The top status bar should show OpenOCD as connected/spawned. If it fails, open:

```text
/log
```

and inspect the error details.

## 6. Attach ProbeStream

Scan target RAM for the ProbeStream control block:

```text
/scan
```

If you set `controlBlockAddr`, `/scan` uses that fixed address. You can also attach directly:

```text
/attach 0x20000000
```

Replace the address with the actual ProbeStream control block address.

When attachment succeeds, the TUI reports the control block address and up/down channel counts.

## 7. Start Streaming

Start the stream reader:

```text
/stream-start
```

Then open the stream page:

```text
/stream
```

You should now see incoming up-channel data if the firmware is calling `PS_Write`, `PS_Print`, or `PS_Printf`.

## 8. Useful Stream Commands

Change which data you see:

```text
/channel 0       View one up-channel
/channel merge   Show all up-channels with channel prefixes
/channel split   Split visible channels into panes
/mode ascii      ASCII-ish byte display
/mode line       Line-oriented text display
/mode hex        Hex dump display
/clear           Clear the stream buffer
```

Graph numeric up-channels and track running stats:

```text
/channel 0 graph-on
/channel 0 graph-off
/channel 0 stats-on
/channel 0 stats-off
```

Graphing and stats activate only when the channel descriptor is numeric, such as data written with `PS_WriteInt`, `PS_WriteUInt`, `PS_WriteFloat`, `PS_WriteDouble`, or a channel marked as `PS_CHANNEL_TYPE_ASCII_NUMBER`. `/clear` clears graph history and running stats along with the stream buffer. The graph/stat toggles and `graphWindowSize` persist, but collected samples do not.

Send data to the target down-channel:

```text
/send hello
/send-hex 01020304
```

Enter terminal mode for repeated down-channel input:

```text
/terminal 0
```

In terminal mode, normal typed text is sent to down-channel `0`. Slash-prefixed commands still work. Use `//text` to send a literal slash-prefixed line to the target.

Leave terminal mode:

```text
/terminal exit
```

## 9. Stop Cleanly

For normal sessions, just quit the TUI. It cleans up the OpenOCD process that it started.

Use the manual stop commands mainly when you are switching probes, hopping between sessions, or intentionally managing OpenOCD yourself.

Stop streaming:

```text
/stop
```

Stop OpenOCD if the TUI spawned it:

```text
/openocd stop
```

Quit the TUI:

```text
/quit
```

or press `Ctrl+C` twice.

## Manual Happy Path

Once settings are saved, the Splash page `Enter` shortcut is usually the fastest path. If you need to step through startup manually, use:

```text
/openocd start
/scan
/stream-start
/stream
```

For a first run with probe selection:

```text
/settings
/probes
/openocd start
/scan
/stream-start
/stream
```

## Built-in Help

Inside the TUI:

```text
?              Page-specific help
/quickstart    Re-open the first-run guide modal
/help          Full command reference
Ctrl+←/→       Switch pages
/log           Inspect command replies and backend errors
```