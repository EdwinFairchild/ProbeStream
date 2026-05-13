import React from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { theme } from "../theme.ts";

export interface SwitcherPage {
  id: string;
  label: string;
  hint: string;
}

interface Props {
  open: boolean;
  pages: SwitcherPage[];
  selected: number;
}

const RESERVED_TOP_ROWS = 1;
const RESERVED_PROMPT_ROWS = 5;
const MODAL_VERTICAL_GUTTER = 2;

export function PageSwitcher({ open, pages, selected }: Props) {
  const { width, height } = useTerminalDimensions();
  const availableWidth = Math.max(20, width - 4);
  const modalWidth = Math.max(20, Math.min(64, availableWidth));
  const availableHeight = Math.max(5, height - RESERVED_TOP_ROWS - RESERVED_PROMPT_ROWS - MODAL_VERTICAL_GUTTER);

  if (!open) return null;
  const active = pages[selected];

  // Build the tab row as a single string with separators for the passive tabs,
  // but we render each tab as its own box so we can style the selected one.
  return (
    <>
      {/* Full-screen dim backdrop */}
      <box
        style={{
          position: "absolute",
          top: RESERVED_TOP_ROWS, left: 0, right: 0, bottom: RESERVED_PROMPT_ROWS,
          backgroundColor: "#000000",
          opacity: 0.55,
        }}
      />

      {/* Floating card centered in the screen */}
      <box
        style={{
          position: "absolute",
          top: RESERVED_TOP_ROWS + 1, left: 0, right: 0, bottom: RESERVED_PROMPT_ROWS + 1,
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
        }}
      >
        <box
          style={{
            flexDirection: "column",
            width: modalWidth,
            maxHeight: availableHeight,
          }}
        >
          {/* Glass body */}
          <box
            style={{
              flexDirection: "column",
              backgroundColor: theme.surface,
              paddingLeft: 2,
              paddingRight: 2,
              paddingTop: 1,
              paddingBottom: 1,
            }}
          >
            {/* Tab strip */}
            <box
              style={{
                flexDirection: "row",
                height: 1,
                flexShrink: 0,
              }}
            >
              {pages.map((p, i) => {
                const sel = i === selected;
                const isLast = i === pages.length - 1;
                return (
                  <box
                    key={p.id}
                    style={{
                      flexDirection: "row",
                      height: 1,
                      flexShrink: 0,
                    }}
                  >
                    <text
                      style={{
                        fg: sel ? theme.accent : theme.textDim,
                        bg: sel ? theme.accentDim : "transparent",
                        paddingLeft: 1,
                        paddingRight: 1,
                        attributes: sel ? TextAttributes.BOLD : TextAttributes.NONE,
                      }}
                      content={p.label}
                    />
                    {!isLast ? (
                      <text
                        style={{ fg: theme.border }}
                        content=" │ "
                      />
                    ) : null}
                  </box>
                );
              })}
            </box>

            {/* Underline accent for selected tab */}
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 0 }}>
              {pages.map((p, i) => {
                const sel = i === selected;
                const labelLen = p.label.length + 2; // +2 for padding
                const sepLen = i < pages.length - 1 ? 3 : 0; // " │ "
                return (
                  <text
                    key={p.id}
                    style={{
                      fg: sel ? theme.accent : theme.surfaceHigh,
                      minWidth: labelLen + sepLen,
                    }}
                    content={"▀".repeat(labelLen) + " ".repeat(sepLen)}
                  />
                );
              })}
            </box>

            {/* Hint */}
            <text
              style={{
                fg: theme.textDim,
                marginTop: 1,
                flexShrink: 0,
              }}
              content={`  ${active?.hint ?? ""}`}
            />

            {/* Footer */}
            <text
              style={{ fg: theme.muted, marginTop: 1, flexShrink: 0 }}
              content="  Enter · Esc  close"
            />
          </box>

        </box>
      </box>
    </>
  );
}
