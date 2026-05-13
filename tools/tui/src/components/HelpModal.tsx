import React from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { theme } from "../theme.ts";

interface Props {
  open: boolean;
  onClose: () => void;
}

const HELP_LINES = [
  "ProbeStream TUI — Keyboard Reference",
  "",
  "  /              Open command prompt",
  "  ?              Page-specific help",
  "  Ctrl+←/→       Switch pages",
  "  Ctrl+C ×2      Quit (single press = arm)",
  "  Esc            Close modal / unfocus prompt",
  "",
  "Commands:",
  "  /splash        Status overview",
  "  /probes        Probe / session list",
  "  /stream        Stream viewer",
  "  /terminal [n]  Terminal mode on down-channel n",
  "  /terminal exit Leave terminal mode",
  "  /settings      TUI settings",
  "  /log           Command/reply/backend log",
  "  /help          This help screen",
  "",
  "  /start         One-shot: OpenOCD → scan RAM → stream",
  "  /stop          Stop streaming",
  "",
  "Advanced (manual control):",
  "  /discover      List attached debug probes",
  "  /scan          Scan RAM for ProbeStream",
  "  /attach <addr> Attach at known address",
  "  /openocd start Spawn OpenOCD",
  "  /openocd connect Connect to existing OpenOCD",
  "  /openocd stop  Stop spawned OpenOCD",
  "  /stream-start  Start stream only (skip OpenOCD/scan)",
  "",
  "  /send <text>   Send text to down-channel",
  "  /send-hex <h>  Send hex bytes",
  "  /channel <n>   Select one up-channel",
  "  /channel <n> graph-on|graph-off",
  "  /channel <n> stats-on|stats-off",
  "  /channel merge Show all up-channels with prefixes",
  "  /channel split Split visible up-channels into panes",
  "  /recent hide|show|clear",
  "  /mode <m>      raw | hex | ascii | line",
  "  /capture on|off|path|format",
  "  /clear         Clear stream buffer",
  "  /copy [log|errors|last] [n]  Copy log to clipboard",
  "  /set <k> <v>   Change a setting",
  "  /quit          Exit",
];

const RESERVED_TOP_ROWS = 1;
const RESERVED_PROMPT_ROWS = 5;
const MODAL_VERTICAL_GUTTER = 2;
const PREFERRED_MODAL_WIDTH = 62;

export function HelpModal({ open, onClose }: Props) {
  const { width, height } = useTerminalDimensions();
  const availableWidth = Math.max(20, width - 4);
  const modalWidth = Math.max(20, Math.min(PREFERRED_MODAL_WIDTH, availableWidth));
  const availableHeight = Math.max(6, height - RESERVED_TOP_ROWS - RESERVED_PROMPT_ROWS - MODAL_VERTICAL_GUTTER);
  const bodyHeight = Math.max(1, Math.min(HELP_LINES.length, availableHeight - 4));
  const hasScroll = HELP_LINES.length > bodyHeight;

  useKeyboard((key) => {
    if (!open) return;
    if (key.name === "escape" || key.name === "return" || key.sequence === "q") {
      onClose();
      key.preventDefault();
      key.stopPropagation();
    }
  });

  if (!open) return null;

  return (
    <>
      <box style={{ position: "absolute", top: RESERVED_TOP_ROWS, left: 0, right: 0, bottom: RESERVED_PROMPT_ROWS, backgroundColor: "#000000", opacity: 0.72 }} />
      <box style={{ position: "absolute", top: RESERVED_TOP_ROWS + 1, left: 0, right: 0, bottom: RESERVED_PROMPT_ROWS + 1, justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
        <box
          style={{
            flexDirection: "column",
            backgroundColor: theme.surface,
            borderStyle: "single",
            borderColor: theme.accent,
            paddingLeft: 2, paddingRight: 2,
            paddingTop: 1, paddingBottom: 1,
            width: modalWidth,
            maxHeight: availableHeight,
          }}
        >
          <scrollbox
            focused
            scrollY
            style={{
              height: bodyHeight,
              width: modalWidth - 4,
              scrollbarOptions: {
                trackOptions: {
                  foregroundColor: theme.accentDim,
                  backgroundColor: theme.surfaceVariant,
                },
              },
            }}
          >
            {HELP_LINES.map((line, i) => (
              <text
                key={i}
                style={{ fg: line.startsWith("  /") ? theme.accent : i === 0 ? theme.primary : theme.text }}
                content={line || " "}
              />
            ))}
          </scrollbox>
          <text style={{ fg: theme.muted, marginTop: 1 }} content={hasScroll ? "↑/↓ scroll  ·  Esc/Enter/q close" : "Esc/Enter/q to close"} />
        </box>
      </box>
    </>
  );
}
