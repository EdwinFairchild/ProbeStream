import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme.ts";
import { Panel } from "../components/Panel.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import type { DebugProbeInfo, HealthResponse, ProbeDiscoveryResult } from "../bridge/types.ts";

interface Props {
  health: HealthResponse | null;
  active: boolean;
  probes: DebugProbeInfo[];
  probeDiscovery: ProbeDiscoveryResult | null;
  probeScanBusy: boolean;
  onRefreshProbes: () => void;
  onQuickStart: () => void;
}

// Box border chars traced as a single perimeter path (top → right → bottom ← left)
const BORDER_TOP    = "┌─────────────┐";  // 15 chars, perimeter pos 0-14
const BORDER_LEFT   = "│";                 // perimeter pos 15
const BORDER_RIGHT  = "│";                 // perimeter pos 16
const BORDER_BOTTOM = "└─────────────┘";  // 15 chars, perimeter pos 17-31
const FILL_CHARS    = "░░▒▒▓▓███".split("");

const FILL_WAVE = (pos: number, f: number) => [
  theme.accentDim, theme.accent, theme.primary,
  theme.text,      theme.primary, theme.accent,
][(pos + f) % 6]!;

export function SplashPage({ health, active, probes, probeDiscovery, probeScanBusy, onRefreshProbes, onQuickStart }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(id);
  }, [active]);

  useKeyboard((key) => {
    if (!active) return;
    if (key.ctrl || key.meta || key.option) return;
    if (key.name === "return" || key.sequence === " ") {
      onQuickStart();
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.sequence === "r" || key.sequence === "R") {
      onRefreshProbes();
      key.preventDefault(); key.stopPropagation();
    }
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
      <box style={{ flexDirection: "column", flexShrink: 0, alignItems: "flex-start", alignSelf: "center" }}>

        {/* Row 0: static border + static title */}
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text style={{ fg: theme.textDim }} content={"  " + BORDER_TOP + "  P R O B E  [ v1.0 ]   "} />
        </box>

        {/* Row 1: │ + animated fills + │ + static right text */}
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text style={{ fg: theme.textDim }} content={"  " + BORDER_LEFT + "  "} />
          {FILL_CHARS.map((ch, i) => (
            <text key={i} style={{ fg: FILL_WAVE(i, frame) }} content={ch} />
          ))}
          <text style={{ fg: theme.textDim }} content={"  " + BORDER_RIGHT + "  S T R E A M ─────────┐"} />
        </box>

        {/* Row 2: static border + static right text */}
        <text style={{ fg: theme.textDim }} content={"  " + BORDER_BOTTOM + "  Telemetry Interface  │"} />

        {/* Row 3: static */}
        <text style={{ fg: theme.textDim }} content={"  ──────────────────────────────────────┘"} />

        <text style={{ fg: theme.textDim, marginTop: 1 }} content="Debug streaming over OpenOCD — Terminal UI" />
      </box>

      <box style={{ flexDirection: "row", marginTop: 2, flexShrink: 0 }}>
        <Panel title="Status">
          <box style={{ flexDirection: "column", padding: 1 }}>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="Sidecar:     " />
              <StatusPill label={health ? "connected" : "waiting..."} status={health ? "ok" : "muted"} />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="OpenOCD:     " />
              <StatusPill
                label={health?.openocd_connected ? "connected" : "disconnected"}
                status={health?.openocd_connected ? "ok" : "muted"}
              />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="ProbeStream: " />
              <StatusPill
                label={health?.probestream_attached ? "attached" : "not attached"}
                status={health?.probestream_attached ? "ok" : "muted"}
              />
            </box>
            <box style={{ flexDirection: "row" }}>
              <text style={{ fg: theme.muted }} content="Streaming:   " />
              <StatusPill
                label={health?.streaming ? "active" : "stopped"}
                status={health?.streaming ? "accent" : "muted"}
              />
            </box>
          </box>
        </Panel>

        <Panel title="Quick Start">
          <box style={{ flexDirection: "column", padding: 1 }}>
            <box style={{ flexDirection: "row", backgroundColor: theme.selectionFocused, paddingLeft: 1, paddingRight: 1, marginBottom: 1 }}>
              <text style={{ fg: theme.accent }} content="[ Enter ]" />
              <text style={{ fg: theme.text, marginLeft: 1 }} content="Start streaming with saved settings" />
            </box>
            <text style={{ fg: theme.text }} content="/start    one-shot: OpenOCD → scan RAM → stream" />
            <text style={{ fg: theme.text }} content="/stop     stop streaming" />
            <text style={{ fg: theme.text }} content="/probes   pick a probe if more than one" />
            <text style={{ fg: theme.text }} content="/settings configure paths · interface · target" />
            <text style={{ fg: theme.text }} content="/log      inspect replies  ·  /copy yank log" />
            <text style={{ fg: theme.muted, marginTop: 1 }} content="Advanced: /openocd start|stop  ·  /scan  ·  /attach <addr>" />
            <text style={{ fg: theme.muted, marginTop: 1 }} content="Press / to open the prompt  ·  ? for help  ·  Ctrl+C ×2 to quit" />
          </box>
        </Panel>

        <Panel title={`Debug Probes${probes.length ? ` (${probes.length})` : ""}`}>
          <box style={{ flexDirection: "column", padding: 1, minWidth: 36 }}>
            {probeScanBusy && probes.length === 0 ? (
              <text style={{ fg: theme.muted }} content="Scanning debug probes..." />
            ) : probes.length === 0 ? (
              <text style={{ fg: theme.muted }} content={probeDiscovery?.error ?? "Press r to refresh"} />
            ) : (
              probes.slice(0, 6).map((probe, index) => (
                <box key={probe.id} style={{ flexDirection: "column", flexShrink: 0, marginBottom: index === probes.length - 1 ? 0 : 1 }}>
                  <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                    <text style={{ fg: theme.accent }} content={`${index + 1}. `} />
                    <text style={{ fg: theme.text }} content={probe.target || probe.product || "Debug probe"} />
                  </box>
                  {probe.serial ? (
                    <text style={{ fg: theme.textDim, marginLeft: 3 }} content={`SN ${probe.serial}`} />
                  ) : null}
                </box>
              ))
            )}
            <text style={{ fg: theme.muted, marginTop: 1 }} content="r refresh  ·  /probes select" />
          </box>
        </Panel>
      </box>
    </box>
  );
}
