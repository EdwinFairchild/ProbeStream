import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme.ts";
import { Panel } from "../components/Panel.tsx";
import { ListRow } from "../components/ListRow.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import type { BridgeClient } from "../bridge/client.ts";
import type { DebugProbeInfo, ProbeDiscoveryResult, SessionInfo } from "../bridge/types.ts";

interface Props {
  client: BridgeClient;
  active: boolean;
  probes: DebugProbeInfo[];
  probeDiscovery: ProbeDiscoveryResult | null;
  selectedProbeSerial: string;
  onRefreshProbes: () => void;
  onSelectProbe: (probe: DebugProbeInfo) => void;
}

export function ProbesPage({
  client,
  active,
  probes,
  probeDiscovery,
  selectedProbeSerial,
  onRefreshProbes,
  onSelectProbe,
}: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedProbe, setSelectedProbe] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await client.sessions();
        if (!cancelled) { setSessions(s); setError(null); }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    poll();
    const id = setInterval(poll, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [client]);

  useEffect(() => {
    if (selectedProbe >= probes.length && probes.length > 0) {
      setSelectedProbe(probes.length - 1);
    }
  }, [probes.length, selectedProbe]);

  useKeyboard((key) => {
    if (!active) return;
    if (key.name === "up") {
      setSelectedProbe((s) => Math.max(0, s - 1));
      key.preventDefault(); key.stopPropagation();
    }
    if (key.name === "down") {
      setSelectedProbe((s) => Math.min(probes.length - 1, s + 1));
      key.preventDefault(); key.stopPropagation();
    }
    if (key.name === "return" || key.sequence === " ") {
      const probe = probes[selectedProbe];
      if (probe) onSelectProbe(probe);
      key.preventDefault(); key.stopPropagation();
    }
    if (key.sequence === "r" || key.sequence === "R") {
      onRefreshProbes();
      key.preventDefault(); key.stopPropagation();
    }
  });

  const sess = sessions[0];
  const selectedProbeInfo = probes[selectedProbe];

  return (
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <Panel title="Debug Probes" flexGrow={3}>
        <box style={{ flexDirection: "column", overflow: "hidden" }}>
          {probes.length === 0 ? (
            <text style={{ fg: theme.muted, padding: 1 }} content={probeDiscovery?.error ?? "No debug probes found. Press r to refresh."} />
          ) : (
            probes.map((probe, i) => {
              const selectedSerial = Boolean(selectedProbeSerial && probe.serial === selectedProbeSerial);
              return (
                <ListRow
                  key={probe.id}
                  label={probe.product || "Debug probe"}
                  value={`${probe.serial || probe.tool}${selectedSerial ? "  selected" : ""}`}
                  focused={i === selectedProbe}
                  accent={selectedSerial}
                />
              );
            })
          )}
          <text style={{ fg: theme.muted, paddingLeft: 1, marginTop: 1 }} content="↑/↓ select  ·  Space/Enter use serial  ·  r refresh" />
        </box>
      </Panel>

      <Panel title="Sessions" flexGrow={3}>
        <box style={{ flexDirection: "column", overflow: "hidden" }}>
          {sessions.length === 0 ? (
            <text style={{ fg: theme.muted, padding: 1 }} content={error ?? "No sessions. Use /openocd start, then /scan"} />
          ) : (
            sessions.map((s, i) => (
              <ListRow
                key={s.id}
                label={`${s.label || s.id}`}
                value={`${s.openocdState}  ${s.probestreamAttached ? "attached" : ""}`}
                focused={i === 0}
              />
            ))
          )}
        </box>
      </Panel>

      <Panel title="Details" flexGrow={4}>
        {selectedProbeInfo ? (
          <box style={{ flexDirection: "column", padding: 1 }}>
            <text style={{ fg: theme.primary }} content={selectedProbeInfo.product || "Debug probe"} />
            <box style={{ flexDirection: "row", marginTop: 1 }}>
              <text style={{ fg: theme.muted }} content="Serial:      " />
              <text style={{ fg: selectedProbeInfo.serial ? theme.accent : theme.muted }} content={selectedProbeInfo.serial || "(not reported)"} />
            </box>
            <box style={{ flexDirection: "row", marginTop: 1 }}>
              <text style={{ fg: theme.muted }} content="Tool:        " />
              <text style={{ fg: theme.text }} content={selectedProbeInfo.tool} />
            </box>
            <box style={{ flexDirection: "row", marginTop: 1 }}>
              <text style={{ fg: theme.muted }} content="Vendor:      " />
              <text style={{ fg: theme.text }} content={selectedProbeInfo.vendor || "(unknown)"} />
            </box>
            {selectedProbeInfo.target ? (
              <box style={{ flexDirection: "row", marginTop: 1 }}>
                <text style={{ fg: theme.muted }} content="Target:      " />
                <text style={{ fg: theme.text }} content={selectedProbeInfo.target} />
              </box>
            ) : null}
            <text style={{ fg: theme.muted, marginTop: 1 }} content="Space/Enter persists this serial to adapterSerial for /openocd start." />
          </box>
        ) : sess ? (
          <box style={{ flexDirection: "column", padding: 1 }}>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="ID:          " />
              <text style={{ fg: theme.text }} content={sess.id} />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="OpenOCD:     " />
              <StatusPill label={sess.openocdState} status={sess.openocdState === "connected" || sess.openocdState === "spawned" ? "ok" : "muted"} />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="TCL:         " />
              <text style={{ fg: theme.text }} content={`${sess.tclHost}:${sess.tclPort}`} />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="Target:      " />
              <text style={{ fg: theme.text }} content={sess.targetConfig || "(none)"} />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="Interface:   " />
              <text style={{ fg: theme.text }} content={sess.interfaceConfig || "(none)"} />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="ProbeStream: " />
              <StatusPill label={sess.probestreamAttached ? "attached" : "not attached"} status={sess.probestreamAttached ? "ok" : "muted"} />
            </box>
            {sess.controlBlockAddr !== null ? (
              <box style={{ flexDirection: "row", marginBottom: 1 }}>
                <text style={{ fg: theme.muted }} content="CB Address:  " />
                <text style={{ fg: theme.accent }} content={`0x${sess.controlBlockAddr.toString(16).padStart(8, "0")}`} />
              </box>
            ) : null}
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="RAM:         " />
              <text style={{ fg: theme.text }} content={`0x${sess.ramStart.toString(16)} (${sess.ramSize} bytes)`} />
            </box>
            <box style={{ flexDirection: "row", marginBottom: 1 }}>
              <text style={{ fg: theme.muted }} content="Channels:    " />
              <text style={{ fg: theme.text }} content={`up=${sess.numUp}  down=${sess.numDown}`} />
            </box>
            {sess.lastError ? (
              <box style={{ flexDirection: "row" }}>
                <text style={{ fg: theme.error }} content={`Error: ${sess.lastError}`} />
              </box>
            ) : null}
          </box>
        ) : (
          <text style={{ fg: theme.muted, padding: 1 }} content="Select a session to view details" />
        )}
      </Panel>
    </box>
  );
}
