import React from "react";
import { theme } from "../theme.ts";

interface Props {
  label: string;
  value?: string;
  focused?: boolean;
  accent?: boolean;
  dimValue?: boolean;
  onClick?: () => void;
}

export function ListRow({ label, value, focused = false, accent = false, dimValue = false }: Props) {
  return (
    <box
      style={{
        flexDirection: "row",
        height: 1,
        flexShrink: 0,
        backgroundColor: focused ? theme.selectionFocused : "transparent",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        style={{ fg: focused ? theme.accent : accent ? theme.primary : theme.text }}
        content={label}
      />
      {value !== undefined ? (
        <text
          style={{ fg: dimValue ? theme.muted : theme.textDim, marginLeft: 1, flexGrow: 1 }}
          content={value}
        />
      ) : null}
    </box>
  );
}
