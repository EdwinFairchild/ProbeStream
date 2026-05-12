import React from "react";
import { theme } from "../theme.ts";

export interface Metric {
  label: string;
  value: string;
  color?: string;
}

interface Props {
  metrics: Metric[];
}

export function MetricStrip({ metrics }: Props) {
  return (
    <box
      style={{
        flexDirection: "row",
        flexShrink: 0,
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.surfaceVariant,
      }}
    >
      {metrics.map((m, i) => (
        <box key={m.label} style={{ flexDirection: "row", marginRight: i < metrics.length - 1 ? 2 : 0 }}>
          <text style={{ fg: theme.muted }} content={`${m.label} `} />
          <text style={{ fg: m.color ?? theme.text }} content={m.value} />
        </box>
      ))}
    </box>
  );
}
