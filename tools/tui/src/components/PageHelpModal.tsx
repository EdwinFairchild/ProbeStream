import React from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { theme } from "../theme.ts";

export type PageHelpId = "splash" | "probes" | "stream" | "settings" | "log";

interface Props {
    open: boolean;
    page: PageHelpId;
    onClose: () => void;
}

const PAGE_HELP: Record<PageHelpId, string[]> = {
    splash: [
        "Splash — Page Help",
        "",
        "Purpose:",
        "  Status overview for sidecar, OpenOCD, ProbeStream,",
        "  streaming state, and attached debug probes.",
        "",
        "Keys:",
        "  Enter / Space  Start previous session with saved settings",
        "  r              Refresh debug probe discovery",
        "  /              Open command prompt",
        "  Ctrl+←/→       Switch pages",
        "",
        "Useful commands:",
        "  /quickstart    Open first-run guide",
        "  /start         OpenOCD → scan RAM → stream",
        "  /probes        Select a probe",
        "  /settings      Configure OpenOCD and target",
    ],
    probes: [
        "Probes — Page Help",
        "",
        "Purpose:",
        "  Pick the debug probe serial used by OpenOCD and",
        "  inspect current sidecar/OpenOCD session details.",
        "",
        "Keys:",
        "  ↑/↓            Move through detected probes",
        "  Space / Enter  Save selected probe serial",
        "  r              Refresh probe discovery",
        "  Ctrl+←/→       Switch pages",
        "",
        "Useful commands:",
        "  /discover      Refresh attached debug probes",
        "  /openocd start Start OpenOCD with saved settings",
        "  /scan          Scan RAM for ProbeStream control block",
        "  /settings      Edit adapterSerial and OpenOCD config",
    ],
    stream: [
        "Stream — Page Help",
        "",
        "Purpose:",
        "  View ProbeStream up-channel data, switch channel views,",
        "  send down-channel text, and manage capture/log output.",
        "",
        "Keys:",
        "  ↑/↓ PgUp/PgDn  Scroll stream output",
        "  Home / End     Jump to start / tail",
        "  /              Open command prompt",
        "  Ctrl+←/→       Switch pages",
        "",
        "Useful commands:",
        "  /channel <n>   View one up-channel",
        "  /channel <n> graph-on|graph-off",
        "  /channel <n> stats-on|stats-off",
        "  /channel merge Show all up-channels with prefixes",
        "  /channel split Split channels into panes",
        "  /mode <m>      raw | hex | ascii | line",
        "  /terminal [n]  Free-text input to down-channel n",
        "  /send <text>   Send one text line",
        "  /capture on    Start capture",
        "  /clear         Clear stream buffer",
    ],
    settings: [
        "Settings — Page Help",
        "",
        "Purpose:",
        "  Edit saved TUI and OpenOCD settings. Changes are persisted",
        "  locally and synced to the sidecar when possible.",
        "",
        "Keys:",
        "  ↑/↓            Select setting",
        "  Space          Toggle/cycle, or edit string values",
        "  Tab / Enter    Edit selected value",
        "  Esc            Cancel value edit",
        "  Ctrl+U         Clear while editing",
        "",
        "Important fields:",
        "  openocdPath    Path to OpenOCD executable",
        "  interfaceConfig OpenOCD interface cfg",
        "  targetConfig   OpenOCD target cfg",
        "  adapterSerial  Probe serial for multi-probe setups",
        "  controlBlockAddr Optional fixed ProbeStream address",
    ],
    log: [
        "Log — Page Help",
        "",
        "Purpose:",
        "  Inspect commands, replies, backend messages, and errors.",
        "  Stream payloads are intentionally omitted here.",
        "",
        "Keys:",
        "  ↑/↓            Scroll back / toward tail",
        "  Home / End     Oldest visible / tail",
        "  c              Clear log",
        "  Ctrl+←/→       Switch pages",
        "",
        "Useful commands:",
        "  /copy log [n]  Copy whole log or last n entries",
        "  /copy errors   Copy only errors",
        "  /copy last     Copy latest entry",
        "  /clear         Clear stream buffer, not this log",
    ],
};

const RESERVED_TOP_ROWS = 1;
const RESERVED_PROMPT_ROWS = 5;
const MODAL_VERTICAL_GUTTER = 2;
const PREFERRED_MODAL_WIDTH = 64;

export function PageHelpModal({ open, page, onClose }: Props) {
    const { width, height } = useTerminalDimensions();
    const lines = PAGE_HELP[page];
    const availableWidth = Math.max(20, width - 4);
    const modalWidth = Math.max(20, Math.min(PREFERRED_MODAL_WIDTH, availableWidth));
    const availableHeight = Math.max(6, height - RESERVED_TOP_ROWS - RESERVED_PROMPT_ROWS - MODAL_VERTICAL_GUTTER);
    const bodyHeight = Math.max(1, Math.min(lines.length, availableHeight - 4));
    const hasScroll = lines.length > bodyHeight;

    useKeyboard((key) => {
        if (!open) return;
        if (key.name === "escape" || key.name === "return" || key.sequence === "q" || key.sequence === "?") {
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
                        {lines.map((line, i) => (
                            <text
                                key={i}
                                style={{
                                    fg:
                                        i === 0 ? theme.primary
                                            : line.startsWith("  /") ? theme.accent
                                                : line.match(/^\s+[A-Z]/) ? theme.text
                                                    : line.match(/^[A-Z]/) ? theme.primary
                                                        : theme.text,
                                }}
                                content={line || " "}
                            />
                        ))}
                    </scrollbox>
                    <text style={{ fg: theme.muted, marginTop: 1 }} content={hasScroll ? "↑/↓ scroll  ·  Esc/Enter/? close  ·  /help full reference" : "Esc/Enter/? close  ·  /help full reference"} />
                </box>
            </box>
        </>
    );
}