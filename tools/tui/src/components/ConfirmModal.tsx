import React from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { theme } from "../theme.ts";

interface Props {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const RESERVED_TOP_ROWS = 1;
const RESERVED_PROMPT_ROWS = 5;
const MODAL_VERTICAL_GUTTER = 2;

export function ConfirmModal({ open, title, message, onConfirm, onCancel }: Props) {
  const { width, height } = useTerminalDimensions();
  const messageLines = message.split(/\r?\n/);
  const lines = [title, "", ...messageLines];
  const availableWidth = Math.max(20, width - 4);
  const modalWidth = Math.max(20, Math.min(64, availableWidth));
  const availableHeight = Math.max(5, height - RESERVED_TOP_ROWS - RESERVED_PROMPT_ROWS - MODAL_VERTICAL_GUTTER);
  const bodyHeight = Math.max(1, Math.min(lines.length, availableHeight - 3));
  const hasScroll = lines.length > bodyHeight;

  useKeyboard((key) => {
    if (!open) return;
    if (key.name === "return" || key.sequence === "y" || key.sequence === "Y") {
      onConfirm();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "escape" || key.sequence === "n" || key.sequence === "N") {
      onCancel();
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
            borderColor: theme.warn,
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
                  foregroundColor: theme.warn,
                  backgroundColor: theme.surfaceVariant,
                },
              },
            }}
          >
            {lines.map((line, index) => (
              <text
                key={index}
                style={{ fg: index === 0 ? theme.warn : theme.text }}
                content={line || " "}
              />
            ))}
          </scrollbox>
          <text style={{ fg: theme.muted, marginTop: 1 }} content={hasScroll ? "↑/↓ scroll  ·  Enter/y confirm  ·  Esc/n cancel" : "Enter/y confirm  ·  Esc/n cancel"} />
        </box>
      </box>
    </>
  );
}
