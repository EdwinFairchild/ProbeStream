import React from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme.ts";

interface Props {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ open, title, message, onConfirm, onCancel }: Props) {
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
      <box style={{ position: "absolute", top: 1, left: 0, right: 0, bottom: 0, backgroundColor: "#000000", opacity: 0.72 }} />
      <box style={{ position: "absolute", top: 1, left: 0, right: 0, bottom: 0, justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
        <box
          style={{
            flexDirection: "column",
            backgroundColor: theme.surface,
            borderStyle: "single",
            borderColor: theme.warn,
            paddingLeft: 2, paddingRight: 2,
            paddingTop: 1, paddingBottom: 1,
          }}
        >
          <text style={{ fg: theme.warn }} content={title} />
          <text style={{ fg: theme.text, marginTop: 1 }} content={message} />
          <text style={{ fg: theme.muted, marginTop: 1 }} content="Enter/y confirm  ·  Esc/n cancel" />
        </box>
      </box>
    </>
  );
}
