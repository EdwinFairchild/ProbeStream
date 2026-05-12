import React from "react";
import { theme } from "../theme.ts";

interface Props {
  label: string;
  status: "ok" | "warn" | "error" | "muted" | "accent";
}

const STATUS_COLORS = {
  ok: () => theme.ok,
  warn: () => theme.warn,
  error: () => theme.error,
  muted: () => theme.muted,
  accent: () => theme.accent,
};

export function StatusPill({ label, status }: Props) {
  const fg = STATUS_COLORS[status]();
  return (
    <box style={{ flexDirection: "row", flexShrink: 0, marginRight: 1 }}>
      <text style={{ fg }} content={`● ${label}`} />
    </box>
  );
}
