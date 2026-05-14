import React from "react";
import { theme } from "../theme.ts";

interface Props {
  title?: string;
  flexGrow?: number;
  flexShrink?: number;
  /** When true, draw the border in the accent colour to mark this pane as the
   *  active resize / scroll target. */
  focused?: boolean;
  children: React.ReactNode;
}

export function Panel({ title, flexGrow = 1, flexShrink = 1, focused = false, children }: Props) {
  return (
    <box
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      style={{
        flexDirection: "column",
        flexGrow,
        flexShrink,
        minWidth: 0,
        minHeight: 0,
        border: true,
        borderStyle: focused ? "double" : "single",
        borderColor: focused ? theme.accent : theme.border,
        backgroundColor: theme.surface,
      }}
    >
      {title ? (
        <box
          style={{
            flexDirection: "row",
            flexShrink: 0,
            backgroundColor: focused ? theme.accent : theme.surfaceVariant,
            paddingLeft: 1,
            paddingRight: 1,
            height: 1,
          }}
        >
          <text style={{ fg: focused ? theme.surface : theme.accent }} content={title} />
        </box>
      ) : null}
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: "hidden" }}>
        {children}
      </box>
    </box>
  );
}
