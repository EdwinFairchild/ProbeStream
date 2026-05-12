import React from "react";
import { theme } from "../theme.ts";

interface Props {
  title?: string;
  flexGrow?: number;
  flexShrink?: number;
  children: React.ReactNode;
}

export function Panel({ title, flexGrow = 1, flexShrink = 1, children }: Props) {
  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow,
        flexShrink,
        minWidth: 0,
        minHeight: 0,
        border: true,
        borderStyle: "single",
        borderColor: theme.border,
        backgroundColor: theme.surface,
      }}
    >
      {title ? (
        <box
          style={{
            flexDirection: "row",
            flexShrink: 0,
            backgroundColor: theme.surfaceVariant,
            paddingLeft: 1,
            paddingRight: 1,
            height: 1,
          }}
        >
          <text style={{ fg: theme.accent }} content={title} />
        </box>
      ) : null}
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: "hidden" }}>
        {children}
      </box>
    </box>
  );
}
