import React, { useCallback, useEffect, useState } from "react";
import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { theme } from "../theme.ts";
import { Panel } from "../components/Panel.tsx";
import {
  SETTING_DEFS,
  canCycleValue,
  canOpenValueEditor,
  nextSettingValue,
  type SettingsMap,
} from "../settings.ts";

type Pane = "list" | "detail";

interface Props {
  active: boolean;
  settings: SettingsMap;
  onChange: (partial: SettingsMap) => void;
  onEditingChange?: (editing: boolean) => void;
}

function normalizeInput(text: string): string {
  return text
    .replace(/\r\n?/g, "")
    .replace(/\n/g, "")
    .replace(/\t/g, " ")
    .split("")
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
}

export function SettingsPage({ active, settings, onChange, onEditingChange }: Props) {
  const [selected, setSelected] = useState(0);
  const [pane, setPane] = useState<Pane>("list");
  const [editBuffer, setEditBuffer] = useState("");
  const [editCursor, setEditCursor] = useState(0);
  const renderer = useRenderer();

  const def = SETTING_DEFS[selected];
  const editing = pane === "detail" && def !== undefined && canOpenValueEditor(def);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  const enterDetail = useCallback(() => {
    if (!def) return;
    if (!canOpenValueEditor(def)) return;
    const current = String(settings[def.id] ?? def.default);
    setEditBuffer(current);
    setEditCursor(current.length);
    setPane("detail");
  }, [def, onChange, settings]);

  const cycleValue = useCallback(() => {
    if (!def || !canCycleValue(def)) return;
    onChange({ [def.id]: nextSettingValue(def, settings[def.id]) });
  }, [def, onChange, settings]);

  const commitEdit = useCallback(() => {
    if (!def) return;
    let value: unknown = editBuffer;
    if (def.type === "bool") {
      value = editBuffer === "true" || editBuffer === "1" || editBuffer === "on";
    }
    onChange({ [def.id]: value });
    setPane("list");
  }, [def, editBuffer, onChange]);

  const cancelEdit = useCallback(() => {
    setPane("list");
  }, []);

  const insertEditText = useCallback((text: string) => {
    const normalized = normalizeInput(text);
    if (!normalized) return false;
    setEditBuffer((buffer) => {
      const pos = Math.min(editCursor, buffer.length);
      const next = buffer.slice(0, pos) + normalized + buffer.slice(pos);
      setEditCursor(pos + normalized.length);
      return next;
    });
    return true;
  }, [editCursor]);

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      if (!active || !editing) return;
      if (insertEditText(decodePasteBytes(event.bytes))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    renderer.keyInput.on("paste", handlePaste);
    return () => {
      renderer.keyInput.off("paste", handlePaste);
    };
  }, [active, editing, insertEditText, renderer]);

  useKeyboard((key) => {
    if (!active) return;

    if (pane === "detail") {
      if (key.name === "escape") {
        cancelEdit();
        key.preventDefault(); key.stopPropagation();
        return;
      }
      if (key.name === "return") {
        commitEdit();
        key.preventDefault(); key.stopPropagation();
        return;
      }
      if (key.name === "backspace") {
        if (editCursor > 0) {
          setEditBuffer((b) => b.slice(0, editCursor - 1) + b.slice(editCursor));
          setEditCursor((c) => c - 1);
        }
        key.preventDefault(); key.stopPropagation();
        return;
      }
      if (key.name === "delete") {
        if (editCursor < editBuffer.length) {
          setEditBuffer((b) => b.slice(0, editCursor) + b.slice(editCursor + 1));
        }
        key.preventDefault(); key.stopPropagation();
        return;
      }
      if (!key.ctrl && !key.meta && !key.option) {
        if (key.name === "left") {
          setEditCursor((c) => Math.max(0, c - 1));
          key.preventDefault(); key.stopPropagation();
          return;
        }
        if (key.name === "right") {
          setEditCursor((c) => Math.min(editBuffer.length, c + 1));
          key.preventDefault(); key.stopPropagation();
          return;
        }
        if (key.name === "home") {
          setEditCursor(0);
          key.preventDefault(); key.stopPropagation();
          return;
        }
        if (key.name === "end") {
          setEditCursor(editBuffer.length);
          key.preventDefault(); key.stopPropagation();
          return;
        }
      }
      // For select type, allow up/down to cycle options while editing
      if (def?.type === "select" && (key.name === "up" || key.name === "down")) {
        const opts = def.options;
        const curIdx = opts.indexOf(editBuffer);
        const dir = key.name === "down" ? 1 : -1;
        const nextIdx = curIdx < 0 ? 0 : (curIdx + dir + opts.length) % opts.length;
        const next = opts[nextIdx]!;
        setEditBuffer(next);
        setEditCursor(next.length);
        key.preventDefault(); key.stopPropagation();
        return;
      }
      if (key.ctrl && key.name === "u") {
        setEditBuffer("");
        setEditCursor(0);
        key.preventDefault(); key.stopPropagation();
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        insertEditText(key.sequence);
        key.preventDefault(); key.stopPropagation();
        return;
      }
      key.preventDefault(); key.stopPropagation();
      return;
    }

    if (key.name === "up") {
      setSelected((s) => Math.max(0, s - 1));
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.name === "down") {
      setSelected((s) => Math.min(SETTING_DEFS.length - 1, s + 1));
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.sequence === " ") {
      if (def && canCycleValue(def)) cycleValue();
      else enterDetail();
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.name === "tab" || key.name === "return") {
      enterDetail();
      key.preventDefault(); key.stopPropagation();
      return;
    }
  });

  return (
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <Panel title={`Settings${pane === "list" ? " ◄" : ""}`} flexGrow={4}>
        <box style={{ flexDirection: "column", overflow: "hidden" }}>
          {SETTING_DEFS.map((d, i) => {
            const isSel = i === selected;
            const val = settings[d.id];
            let display: string;
            if (d.type === "bool") {
              display = val ? "ON" : "OFF";
            } else {
              display = String(val ?? d.default);
            }
            return (
              <box
                key={d.id}
                style={{
                  flexDirection: "row",
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: isSel ? theme.selectionFocused : "transparent",
                  paddingLeft: 1,
                  paddingRight: 1,
                }}
              >
                <text
                  style={{ fg: isSel ? theme.accent : theme.text, minWidth: 24 }}
                  content={d.label}
                />
                <text
                  style={{
                    fg: d.type === "bool"
                      ? (val ? theme.ok : theme.muted)
                      : theme.textDim,
                    flexGrow: 1,
                  }}
                  content={display}
                />
              </box>
            );
          })}
        </box>
      </Panel>

      <Panel title={`Edit${pane === "detail" ? " ◄" : ""}`} flexGrow={3}>
        {def ? (
          <box style={{ flexDirection: "column", padding: 1 }}>
            <text style={{ fg: theme.primary }} content={def.label} />
            <text style={{ fg: theme.text, marginTop: 1 }} content={def.description} />
            <text style={{ fg: theme.muted, marginTop: 1 }} content={`ID: ${def.id}  Type: ${def.type}  Default: ${def.default}`} />
            {def.type === "select" ? (
              <text
                style={{ fg: theme.muted }}
                content={`Options: ${(def as { options: readonly string[] }).options.join(", ")}`}
              />
            ) : null}

            {/* Value editor */}
            <box style={{ flexDirection: "column", marginTop: 1 }}>
              <text style={{ fg: theme.textDim }} content="Value:" />
              <box
                style={{
                  flexDirection: "row",
                  backgroundColor: editing ? theme.surfaceHigh : theme.surfaceVariant,
                  border: true,
                  borderStyle: "single",
                  borderColor: editing ? theme.borderFocus : theme.border,
                  paddingLeft: 1,
                  paddingRight: 1,
                  height: 3,
                  alignItems: "center",
                  marginTop: 0,
                }}
              >
                {editing ? (
                  <box style={{ flexDirection: "row", flexGrow: 1 }}>
                    {editCursor > 0 ? (
                      <text style={{ fg: theme.text }} content={editBuffer.slice(0, editCursor)} />
                    ) : null}
                    <text
                      style={{ fg: theme.bg, bg: theme.text }}
                      content={editCursor < editBuffer.length ? editBuffer[editCursor] : " "}
                    />
                    {editCursor < editBuffer.length ? (
                      <text style={{ fg: theme.text }} content={editBuffer.slice(editCursor + 1)} />
                    ) : null}
                    <text style={{ flexGrow: 1 }} content="" />
                  </box>
                ) : (
                  <text
                    style={{ fg: theme.textDim, flexGrow: 1 }}
                    content={def.type === "bool"
                      ? (settings[def.id] ? "ON" : "OFF")
                      : String(settings[def.id] ?? def.default)}
                  />
                )}
              </box>
            </box>

            {/* Hint */}
            <text style={{ fg: theme.muted, marginTop: 1 }} content={
              editing
                ? def.type === "select"
                  ? "type or ↑/↓ cycle  ·  Enter save  ·  Esc cancel  ·  Ctrl+U clear"
                  : "type to edit  ·  Enter save  ·  Esc cancel  ·  Ctrl+U clear"
                : def.type === "bool"
                  ? "Space to toggle"
                  : canCycleValue(def)
                    ? "Space to cycle value"
                    : "Tab/Enter/Space to edit value"
            } />
          </box>
        ) : null}
      </Panel>
    </box>
  );
}
