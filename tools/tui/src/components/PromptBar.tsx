import React, { useCallback, useEffect, useRef, useState } from "react";
import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { isSlashKey, isTabKey } from "../keyboard.ts";
import { theme } from "../theme.ts";

interface Props {
  enabled: boolean;
  inputActive: boolean;
  activationToken: number;
  activationInsertsSlash?: boolean;
  onInputActiveChange?: (active: boolean) => void;
  onSubmit: (line: string) => void;
  hint?: string;
  slashCommands?: string[];
  onCompleterActive?: (active: boolean) => void;
  onBufferChange?: (empty: boolean) => void;
  allowFreeInput?: boolean;
}

const POPUP_MAX_ROWS = 8;

function normalizeInputText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .split("")
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
}

type PopupItem = {
  kind: "command" | "history";
  label: string;
  insert: string;
  replacePrefix: string;
};

export function PromptBar({
  enabled,
  inputActive,
  activationToken,
  activationInsertsSlash = false,
  onInputActiveChange,
  onSubmit,
  hint,
  slashCommands,
  onCompleterActive,
  onBufferChange,
  allowFreeInput = false,
}: Props) {
  const [buffer, setBuffer] = useState("");
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<PopupItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const renderer = useRenderer();

  const seenActivationToken = useRef(0);
  const popupOpen = items.length > 0;

  useEffect(() => { onBufferChange?.(buffer === ""); }, [buffer, onBufferChange]);
  useEffect(() => { onCompleterActive?.(popupOpen); }, [popupOpen, onCompleterActive]);

  useEffect(() => {
    if (selected >= items.length && items.length > 0) {
      setSelected(items.length - 1);
    }
  }, [items.length, selected]);

  const closePopup = useCallback(() => {
    setItems([]);
    setSelected(0);
  }, []);

  const requestComplete = useCallback(
    (src: string) => {
      const trimmed = src.trimStart();
      if (!trimmed || !trimmed.startsWith("/") || !slashCommands?.length) {
        closePopup();
        return;
      }
      if (/\s/.test(trimmed)) {
        closePopup();
        return;
      }
      const head = trimmed.slice(1).split(/\s+/)[0] ?? "";
      const needle = head.toLowerCase();
      const hits = slashCommands
        .filter((c) => c.toLowerCase().startsWith(needle))
        .sort();
      if (hits.length === 0 && head.length > 0) {
        closePopup();
        return;
      }
      const historyItems = history
        .filter((line, index) => history.lastIndexOf(line) === index)
        .filter((line) => trimmed === "/" || line.toLowerCase().startsWith(trimmed.toLowerCase()))
        .map((line): PopupItem => ({
          kind: "history",
          label: line,
          insert: line,
          replacePrefix: src,
        }));
      const commandItems = hits.map((command): PopupItem => ({
        kind: "command",
        label: `/${command}`,
        insert: command,
        replacePrefix: head,
      }));
      setItems([...historyItems, ...commandItems]);
      setSelected(commandItems.length > 0 ? historyItems.length : 0);
    },
    [closePopup, history, slashCommands],
  );

  useEffect(() => {
    if (!enabled || activationToken === 0) return;
    if (seenActivationToken.current === activationToken) return;
    seenActivationToken.current = activationToken;
    onInputActiveChange?.(true);
    setBuffer((buffer) => {
      if (!activationInsertsSlash || buffer !== "") {
        if (buffer !== "") requestComplete(buffer);
        setCursor(buffer.length);
        return buffer;
      }
      requestComplete("/");
      setCursor(1);
      return "/";
    });
  }, [activationInsertsSlash, activationToken, enabled, onInputActiveChange, requestComplete]);

  const acceptItem = useCallback(
    (item: PopupItem) => {
      setBuffer((b) => {
        const next = b.slice(0, b.length - item.replacePrefix.length) + item.insert;
        setCursor(next.length);
        return next;
      });
      closePopup();
    },
    [closePopup],
  );

  const pushHistory = useCallback((line: string) => {
    setHistory((items) => {
      const next = items.at(-1) === line ? items : [...items, line];
      return next.slice(-100);
    });
  }, []);

  const insertText = useCallback(
    (text: string) => {
      const normalized = normalizeInputText(text);
      if (!normalized) return false;
      if (buffer === "" && !allowFreeInput && !normalized.startsWith("/")) return false;
      setBuffer((buffer) => {
        const pos = Math.min(cursor, buffer.length);
        const next = buffer.slice(0, pos) + normalized + buffer.slice(pos);
        setCursor(pos + normalized.length);
        requestComplete(next);
        return next;
      });
      return true;
    },
    [allowFreeInput, buffer, cursor, requestComplete],
  );

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      if (!enabled) return;
      if (!inputActive) {
        if (!allowFreeInput) return;
        onInputActiveChange?.(true);
      }
      if (insertText(decodePasteBytes(event.bytes))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    renderer.keyInput.on("paste", handlePaste);
    return () => {
      renderer.keyInput.off("paste", handlePaste);
    };
  }, [allowFreeInput, enabled, inputActive, insertText, onInputActiveChange, renderer]);

  useKeyboard((key) => {
    if (!enabled) return;

    if (!inputActive) {
      if (isSlashKey(key)) return;
      if (allowFreeInput && key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        onInputActiveChange?.(true);
        if (insertText(key.sequence)) {
          key.preventDefault();
          key.stopPropagation();
        }
      }
      return;
    }

    if (key.name === "escape") {
      closePopup();
      onInputActiveChange?.(false);
      key.preventDefault();
      key.stopPropagation();
      return;
    }

    if (!key.ctrl && !key.meta && !key.option) {
      if (key.name === "left") {
        setCursor((c) => Math.max(0, c - 1));
        key.preventDefault(); key.stopPropagation(); return;
      }
      if (key.name === "right") {
        setCursor((c) => Math.min(buffer.length, c + 1));
        key.preventDefault(); key.stopPropagation(); return;
      }
      if (key.name === "home") {
        setCursor(0); key.preventDefault(); key.stopPropagation(); return;
      }
      if (key.name === "end") {
        setCursor(buffer.length); key.preventDefault(); key.stopPropagation(); return;
      }
    }

    if (key.ctrl || key.meta || key.option) return;

    if (popupOpen) {
      if (isTabKey(key)) {
        const item = items[selected];
        if (item !== undefined) acceptItem(item);
        key.preventDefault(); key.stopPropagation(); return;
      }
      if (key.name === "up") {
        setSelected((s) => Math.max(0, s - 1));
        key.preventDefault(); key.stopPropagation(); return;
      }
      if (key.name === "down") {
        setSelected((s) => Math.min(items.length - 1, s + 1));
        key.preventDefault(); key.stopPropagation(); return;
      }
    }

    if (key.name === "return") {
      if (buffer === "") { key.preventDefault(); key.stopPropagation(); return; }
      const line = buffer.trim();
      setBuffer(""); setCursor(0); closePopup();
      if (line) { pushHistory(line); onSubmit(line); }
      onInputActiveChange?.(false);
      key.preventDefault(); key.stopPropagation(); return;
    }
    if (key.name === "backspace") {
      if (buffer === "" || cursor === 0) { key.preventDefault(); key.stopPropagation(); return; }
      setBuffer((b) => {
        const pos = Math.min(cursor, b.length);
        const next = b.slice(0, pos - 1) + b.slice(pos);
        setCursor(pos - 1);
        requestComplete(next);
        return next;
      });
      if (!allowFreeInput && buffer.length === 1) {
        closePopup();
        onInputActiveChange?.(false);
      }
      key.preventDefault(); key.stopPropagation(); return;
    }
    if (isTabKey(key) && slashCommands?.length) {
      requestComplete(buffer);
      key.preventDefault(); key.stopPropagation(); return;
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      insertText(key.sequence);
      key.preventDefault(); key.stopPropagation(); return;
    }
    key.preventDefault(); key.stopPropagation();
  });

  const showCursor = enabled && inputActive;
  const windowStart = Math.max(
    0,
    Math.min(items.length - POPUP_MAX_ROWS, selected - Math.floor(POPUP_MAX_ROWS / 2)),
  );
  const visible = items.slice(windowStart, windowStart + POPUP_MAX_ROWS);
  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, items.length - (windowStart + visible.length));

  return (
    <box style={{ flexDirection: "column", marginTop: 1, marginBottom: 1, flexShrink: 0 }}>
      {popupOpen ? (
        <box
          style={{
            flexDirection: "column",
            marginLeft: 2, marginRight: 2,
            backgroundColor: theme.surface,
            border: true, borderStyle: "single", borderColor: theme.border,
            paddingLeft: 1, paddingRight: 1, flexShrink: 0,
          }}
        >
          {hiddenAbove > 0 ? <text style={{ fg: theme.muted }} content={`  ↑ ${hiddenAbove} more`} /> : null}
          {visible.map((item, i) => {
            const idx = windowStart + i;
            const isSel = idx === selected;
            return (
              <box key={`${item.kind}:${item.label}:${idx}`} style={{ flexDirection: "row", backgroundColor: isSel ? theme.surfaceVariant : theme.surface }}>
                <text style={{ fg: isSel ? theme.accent : theme.muted }} content={isSel ? "› " : "  "} />
                <text style={{ fg: isSel ? theme.text : theme.textDim, flexGrow: 1 }} content={item.kind === "history" ? `history  ${item.label}` : item.label} />
              </box>
            );
          })}
          {hiddenBelow > 0 ? <text style={{ fg: theme.muted }} content={`  ↓ ${hiddenBelow} more`} /> : null}
          <text style={{ fg: theme.muted }} content="  ↑/↓ select  ·  Tab insert  ·  Esc focus panes" />
        </box>
      ) : null}
      <box
        style={{
          flexDirection: "row",
          backgroundColor: theme.surface,
          border: true, borderStyle: "rounded",
          borderColor: inputActive ? theme.borderFocus : theme.border,
          paddingLeft: 1, paddingRight: 1,
          height: 3, flexShrink: 0, alignItems: "center",
        }}
      >
        <text style={{ fg: enabled && inputActive ? theme.primary : theme.muted }} content="❯ " />
        {buffer.length > 0 ? (
          <box style={{ flexDirection: "row", flexGrow: 1 }}>
            {cursor > 0 ? <text style={{ fg: theme.text }} content={buffer.slice(0, cursor)} /> : null}
            {showCursor ? <text style={{ fg: theme.bg, bg: theme.text }} content={cursor < buffer.length ? buffer[cursor] : " "} /> : null}
            {cursor < buffer.length ? <text style={{ fg: theme.text }} content={buffer.slice(showCursor ? cursor + 1 : cursor)} /> : null}
            <text style={{ flexGrow: 1 }} content="" />
          </box>
        ) : showCursor ? (
          <box style={{ flexDirection: "row", flexGrow: 1 }}>
            <text style={{ fg: theme.bg, bg: theme.text }} content=" " />
            <text style={{ flexGrow: 1 }} content="" />
          </box>
        ) : (
          <text style={{ fg: theme.muted, flexGrow: 1 }} content={hint ?? "press / for commands"} />
        )}
      </box>
      <box style={{ flexDirection: "row", paddingLeft: 2, paddingRight: 2 }}>
        <text
          style={{ fg: theme.muted }}
          content={allowFreeInput
            ? "type text to send  ·  / command  ·  enter send  ·  esc focus panes"
            : "/ command  ·  enter send  ·  tab complete  ·  esc focus panes"}
        />
      </box>
    </box>
  );
}
