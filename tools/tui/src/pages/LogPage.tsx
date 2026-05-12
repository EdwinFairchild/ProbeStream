import React, { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme.ts";
import { Panel } from "../components/Panel.tsx";
import { MetricStrip, type Metric } from "../components/MetricStrip.tsx";

export type LogKind = "command" | "reply" | "error" | "backend" | "info";

export interface AppLogEntry {
  id: number;
  ts: number;
  kind: LogKind;
  message: string;
  detail?: string;
}

interface Props {
  active: boolean;
  entries: AppLogEntry[];
  onClear: () => void;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function colorFor(kind: LogKind): string {
  switch (kind) {
    case "command": return theme.accent;
    case "reply": return theme.ok;
    case "error": return theme.error;
    case "backend": return theme.warn;
    default: return theme.textDim;
  }
}

export function LogPage({ active, entries, onClear }: Props) {
  const [offset, setOffset] = useState(0);

  useKeyboard((key) => {
    if (!active) return;
    if (key.ctrl || key.meta || key.option) return;

    if (key.name === "up") {
      setOffset((o) => Math.min(Math.max(0, entries.length - 1), o + 1));
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.name === "down") {
      setOffset((o) => Math.max(0, o - 1));
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.name === "home") {
      setOffset(Math.max(0, entries.length - 1));
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.name === "end") {
      setOffset(0);
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.sequence === "c" || key.sequence === "C") {
      onClear();
      setOffset(0);
      key.preventDefault(); key.stopPropagation();
    }
  });

  const metrics: Metric[] = useMemo(() => {
    const errors = entries.filter((entry) => entry.kind === "error").length;
    const backend = entries.filter((entry) => entry.kind === "backend").length;
    return [
      { label: "entries", value: String(entries.length) },
      { label: "errors", value: String(errors), color: errors > 0 ? theme.error : theme.muted },
      { label: "backend", value: String(backend), color: backend > 0 ? theme.warn : theme.muted },
      { label: "view", value: offset > 0 ? `${offset} back` : "tail", color: offset > 0 ? theme.accent : theme.textDim },
    ];
  }, [entries, offset]);

  const visible = useMemo(() => {
    const end = Math.max(0, entries.length - offset);
    const start = Math.max(0, end - 120);
    return entries.slice(start, end);
  }, [entries, offset]);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <MetricStrip metrics={metrics} />
      <Panel title="Log">
        <box style={{ flexDirection: "column", overflow: "hidden", flexGrow: 1, padding: 1 }}>
          {visible.length === 0 ? (
            <text style={{ fg: theme.muted }} content="No log entries yet. Run a command to see requests, replies, and backend messages here." />
          ) : (
            visible.map((entry) => (
              <box key={entry.id} style={{ flexDirection: "column", flexShrink: 0 }}>
                <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                  <text style={{ fg: theme.muted }} content={`${timeOf(entry.ts)} `} />
                  <text style={{ fg: colorFor(entry.kind), minWidth: 8 }} content={entry.kind} />
                  <text style={{ fg: entry.kind === "error" ? theme.error : theme.text }} content={entry.message} />
                </box>
                {entry.detail ? (
                  <text style={{ fg: theme.textDim, marginLeft: 17, flexShrink: 0 }} content={entry.detail} />
                ) : null}
              </box>
            ))
          )}
        </box>
      </Panel>
      <box style={{ flexDirection: "row", flexShrink: 0, height: 1, paddingLeft: 1, backgroundColor: theme.surfaceVariant }}>
        <text style={{ fg: theme.muted }} content="↑/↓ scroll  ·  Home/End jump  ·  c clear  ·  stream payloads are omitted" />
      </box>
    </box>
  );
}