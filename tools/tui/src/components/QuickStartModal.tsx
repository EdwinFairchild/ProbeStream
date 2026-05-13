import React, { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { theme } from "../theme.ts";

interface Props {
    open: boolean;
    onClose: (doNotShowAgain: boolean) => void;
}

const LINES = [
    "ProbeStream TUI — Quick Start",
    "",
    "Getting around:",
    "  /              Focus the command prompt",
    "  ?              Open the keyboard reference",
    "  Ctrl+←/→       Cycle pages",
    "  ↑↓             Scroll prompt history",
    "  Tab            Autocomplete command",
    "  Esc            Close modal / unfocus prompt",
    "  Ctrl+C ×2      Quit  (first press arms the exit)",
    "",
    "Splash page:",
    "  Enter / Space  Resume streaming with saved settings",
    "",
    "Terminal mode  (/terminal [n]):",
    "  Free text goes straight to down-channel n",
    "  / commands still work   · // sends a literal /",
    "",
    "First-run workflow:",
    "  /settings      OpenOCD path · interface · target",
    "  /probes        Select probe (multi-probe setups)",
    "  /start         OpenOCD → scan RAM → start stream",
    "  /stream        View incoming channel data",
    "  /stop          Stop streaming",
    "",
    "  /quickstart    Re-open this guide at any time",
];

const RESERVED_TOP_ROWS = 1;
const RESERVED_PROMPT_ROWS = 5;
const MODAL_VERTICAL_GUTTER = 2;
const PREFERRED_MODAL_WIDTH = 58;

export function QuickStartModal({ open, onClose }: Props) {
    const [doNotShow, setDoNotShow] = useState(false);
    const { width, height } = useTerminalDimensions();
    const availableWidth = Math.max(20, width - 4);
    const modalWidth = Math.max(20, Math.min(PREFERRED_MODAL_WIDTH, availableWidth));
    const availableHeight = Math.max(7, height - RESERVED_TOP_ROWS - RESERVED_PROMPT_ROWS - MODAL_VERTICAL_GUTTER);
    const bodyHeight = Math.max(1, Math.min(LINES.length, availableHeight - 5));
    const hasScroll = LINES.length > bodyHeight;

    useKeyboard((key) => {
        if (!open) return;
        if (key.sequence === " ") {
            setDoNotShow((v) => !v);
            key.preventDefault();
            key.stopPropagation();
            return;
        }
        if (key.name === "escape" || key.name === "return" || key.sequence === "q") {
            onClose(doNotShow);
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
                        {LINES.map((line, i) => (
                            <text
                                key={i}
                                style={{
                                    fg:
                                        i === 0 ? theme.primary
                                            : line.startsWith("  /") ? theme.accent
                                                : line.match(/^\s+[A-Z][a-z]/) ? theme.text
                                                    : line.match(/^[A-Z]/) ? theme.primary
                                                        : theme.text,
                                }}
                                content={line || " "}
                            />
                        ))}
                    </scrollbox>
                    <box style={{ flexDirection: "row", marginTop: 1 }}>
                        <text
                            style={{ fg: doNotShow ? theme.accent : theme.muted }}
                            content={doNotShow ? "[x] Do not show again" : "[ ] Do not show again"}
                        />
                        <text style={{ fg: theme.muted }} content="  Space to toggle" />
                    </box>
                    <text style={{ fg: theme.muted, marginTop: 0 }} content={hasScroll ? "↑/↓ scroll  ·  Esc/Enter/q close" : "Esc/Enter/q to close"} />
                </box>
            </box>
        </>
    );
}
