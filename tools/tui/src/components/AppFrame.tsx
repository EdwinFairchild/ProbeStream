import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme, applyTheme } from "../theme.ts";
import { isSlashKey } from "../keyboard.ts";
import type { BridgeClient } from "../bridge/client.ts";
import type { DebugProbeInfo, HealthResponse, ProbeDiscoveryResult } from "../bridge/types.ts";
import type { DisplayMode } from "../decoders/index.ts";
import { PromptBar } from "./PromptBar.tsx";
import { PageSwitcher, type SwitcherPage } from "./PageSwitcher.tsx";
import { HelpModal } from "./HelpModal.tsx";
import { PageHelpModal } from "./PageHelpModal.tsx";
import { QuickStartModal } from "./QuickStartModal.tsx";
import { ConfirmModal } from "./ConfirmModal.tsx";
import { SplashPage } from "../pages/SplashPage.tsx";
import { ProbesPage } from "../pages/ProbesPage.tsx";
import { StreamPage, type CommandHistoryEntry, type StreamChannelLayout } from "../pages/StreamPage.tsx";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { LogPage, type AppLogEntry, type LogKind } from "../pages/LogPage.tsx";
import { withDefaults, getBool, getString, type SettingsMap } from "../settings.ts";
import { loadLocalSettings, saveLocalSettings, settingsPath } from "../settingsStorage.ts";
import { copyToClipboard } from "../clipboard.ts";
import { formatChannelSet, parseChannelSet } from "../graphing.ts";

type PageId = "splash" | "probes" | "stream" | "settings" | "log";

function parseAddr(s: string | undefined): number {
  if (!s) return NaN;
  const t = s.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return NaN;
}

interface AppFrameProps {
  client: BridgeClient;
  onQuit: () => void;
  initialSidecarLog?: readonly string[];
  subscribeSidecarLog?: (listener: (line: string) => void) => () => void;
  clearSidecarLog?: () => void;
}

function detailOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeCommandLine(line: string): string {
  const trimmed = line.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head.startsWith("/") ? head.slice(1) : head;
  const argText = rest.join(" ");
  if (command === "send") return `/send <${argText.length} chars>`;
  if (command === "send-hex") return `/send-hex <${argText.length} hex chars>`;
  return trimmed;
}

function initialLogEntries(lines: readonly string[] | undefined): AppLogEntry[] {
  const now = Date.now();
  return (lines ?? []).map((line, index) => ({
    id: index + 1,
    ts: now,
    kind: "backend" as const,
    message: line,
  }));
}

export function AppFrame({ client, onQuit, initialSidecarLog, subscribeSidecarLog, clearSidecarLog }: AppFrameProps) {
  const [page, setPage] = useState<PageId>("splash");
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [debugProbes, setDebugProbes] = useState<DebugProbeInfo[]>([]);
  const [probeDiscovery, setProbeDiscovery] = useState<ProbeDiscoveryResult | null>(null);
  const [probeScanBusy, setProbeScanBusy] = useState(false);
  const [settings, setSettings] = useState<SettingsMap>(() => withDefaults(loadLocalSettings()));
  const [logEntries, setLogEntries] = useState<AppLogEntry[]>(() => initialLogEntries(initialSidecarLog));
  const [helpOpen, setHelpOpen] = useState(false);
  const [pageHelpOpen, setPageHelpOpen] = useState(false);
  const [quickStartOpen, setQuickStartOpen] = useState<boolean>(() => {
    const local = loadLocalSettings();
    return local["quickStartSeen"] !== "true";
  });
  const [promptInputActive, setPromptInputActive] = useState(false);
  const [promptActivationToken, setPromptActivationToken] = useState(0);
  const [promptActivationInsertsSlash, setPromptActivationInsertsSlash] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherIdx, setSwitcherIdx] = useState(0);
  const [completerActive, setCompleterActive] = useState(false);
  const [promptEmpty, setPromptEmpty] = useState(true);
  const nextLogIdRef = useRef((initialSidecarLog?.length ?? 0) + 1);
  const probeRefreshRef = useRef<Promise<ProbeDiscoveryResult | null> | null>(null);
  const quitArmedRef = useRef<number>(0);

  // Stream page state
  const [displayMode, setDisplayMode] = useState<DisplayMode>("ascii");
  const [selectedChannel, setSelectedChannel] = useState(0);
  const [channelLayout, setChannelLayout] = useState<StreamChannelLayout>("single");
  const [streamClearSignal, setStreamClearSignal] = useState(0);

  // Terminal mode state
  const [terminalMode, setTerminalMode] = useState(false);
  const [downChannel, setDownChannel] = useState(0);
  const [recentCommands, setRecentCommands] = useState<CommandHistoryEntry[]>([]);
  const [recentCommandsCollapsed, setRecentCommandsCollapsed] = useState(false);
  const nextRecentCommandIdRef = useRef(1);

  // Confirm modal
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; action: () => void } | null>(null);

  const appendLog = useCallback((kind: LogKind, message: string, detail?: unknown) => {
    const entry: AppLogEntry = {
      id: nextLogIdRef.current++,
      ts: Date.now(),
      kind,
      message,
      detail: detailOf(detail),
    };
    setLogEntries((entries) => [...entries, entry].slice(-500));
  }, []);

  const clearLog = useCallback(() => {
    clearSidecarLog?.();
    setLogEntries([]);
    nextLogIdRef.current = 1;
  }, [clearSidecarLog]);

  const report = useCallback((message: string, kind: LogKind = "info", detail?: unknown) => {
    setFlash(message);
    appendLog(kind, message, detail);
  }, [appendLog]);

  const reportError = useCallback((message: string, detail?: unknown) => {
    setFlash(message);
    setError(message);
    appendLog("error", message, detail);
  }, [appendLog]);

  const clearStream = useCallback(() => {
    setStreamClearSignal((signal) => signal + 1);
    client.streamClear()
      .then((r) => report("stream cleared", "reply", r))
      .catch((e) => reportError(`clear stream failed: ${errorMessage(e)}`));
  }, [client, report, reportError]);

  useEffect(() => {
    if (!subscribeSidecarLog) return;
    return subscribeSidecarLog((line) => appendLog("backend", line));
  }, [appendLog, subscribeSidecarLog]);

  const refreshHealth = useCallback(() => {
    client.health().then(setHealth).catch(() => setHealth(null));
  }, [client]);

  const refreshProbes = useCallback(async () => {
    if (probeRefreshRef.current) return probeRefreshRef.current;
    setProbeScanBusy(true);
    const request = (async () => {
      try {
        const result = await client.discoverProbes();
        setProbeDiscovery(result);
        setDebugProbes(result.probes);
        appendLog(result.probes.length > 0 ? "reply" : "info", `debug probes: ${result.probes.length}`, result.error ?? result.tools);
        return result;
      } catch (err) {
        const message = `probe discovery failed: ${errorMessage(err)}`;
        setProbeDiscovery({ ok: false, probes: [], tools: [], error: message });
        setDebugProbes([]);
        appendLog("error", message);
        return null;
      } finally {
        setProbeScanBusy(false);
        probeRefreshRef.current = null;
      }
    })();
    probeRefreshRef.current = request;
    return request;
  }, [appendLog, client]);

  // Health probe
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const h = await client.health();
        if (!cancelled) setHealth(h);
      } catch { if (!cancelled) setHealth(null); }
    };
    probe();
    const id = setInterval(probe, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [client]);

  useEffect(() => {
    refreshProbes().catch(() => { });
  }, [refreshProbes]);

  // Auto-clear flash
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 2_500);
    return () => clearTimeout(id);
  }, [flash]);

  // Load settings from sidecar
  useEffect(() => {
    let cancelled = false;
    client.settingsGet()
      .then((s) => {
        if (cancelled) return;
        const local = loadLocalSettings();
        const merged = withDefaults({ ...s, ...local });
        applyTheme(getString(merged, "themeName"));
        setSettings(merged);
        saveLocalSettings(merged);
        appendLog("info", `settings loaded from ${settingsPath()}`);
        client.settingsSet(merged).catch((err) => {
          appendLog("error", "settings sync failed", errorMessage(err));
        });
      })
      .catch((err) => {
        if (!cancelled) appendLog("error", "settings load failed", errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [appendLog, client]);

  const updateSettings = useCallback((partial: SettingsMap) => {
    setSettings((s) => {
      const next = { ...s, ...partial };
      if ("themeName" in partial) applyTheme(getString(next, "themeName"));
      try {
        saveLocalSettings(next);
      } catch (err) {
        appendLog("error", "local settings save failed", errorMessage(err));
      }
      return next;
    });
    client.settingsSet(partial)
      .then((merged) => {
        const next = withDefaults(merged);
        applyTheme(getString(next, "themeName"));
        setSettings(next);
      })
      .catch((err) => reportError("settings save failed", errorMessage(err)));
  }, [appendLog, client, reportError]);

  const SLASH_COMMANDS = useMemo(() => [
    "splash", "probes", "stream", "terminal", "settings", "log", "logs", "help",
    "start", "stop", "pause", "resume",
    "quickstart",
    "discover", "scan", "attach", "openocd", "stream-start",
    "send", "send-hex",
    "channel", "recent", "mode", "clear", "clearstream", "clearlog",
    "capture", "copy", "set", "quit", "exit",
  ], []);

  const SWITCHER_PAGES = useMemo<SwitcherPage[]>(() => [
    { id: "splash", label: "Splash", hint: "status overview" },
    { id: "probes", label: "Probes", hint: "sessions · OpenOCD" },
    { id: "stream", label: "Stream", hint: "up-channel data viewer" },
    { id: "settings", label: "Settings", hint: "configuration" },
    { id: "log", label: "Log", hint: "commands · replies · backend messages" },
  ], []);

  const openocdOptions = useCallback((adapterSerial?: string) => ({
    openocdPath: getString(settings, "openocdPath") || undefined,
    scriptsPath: getString(settings, "openocdScriptsPath") || undefined,
    interfaceConfig: getString(settings, "interfaceConfig") || undefined,
    targetConfig: getString(settings, "targetConfig") || undefined,
    adapterSerial: (adapterSerial ?? getString(settings, "adapterSerial")) || undefined,
    tclPort: parseInt(getString(settings, "tclPort"), 10) || undefined,
  }), [settings]);

  const scanProbeStream = useCallback(async () => {
    const cb = getString(settings, "controlBlockAddr").trim();
    if (cb) {
      const addr = parseAddr(cb);
      if (!Number.isFinite(addr)) throw new Error(`invalid controlBlockAddr: ${cb}`);
      return client.attach(addr);
    }
    return client.discover({
      ramStart: parseAddr(getString(settings, "ramStart")) || undefined,
      ramSize: parseInt(getString(settings, "ramSize"), 10) || undefined,
      scanChunkSize: parseInt(getString(settings, "scanChunkSize"), 10) || undefined,
    });
  }, [client, settings]);

  const quickStartStreaming = useCallback(async () => {
    appendLog("command", "quick start streaming");
    try {
      let adapterSerial = getString(settings, "adapterSerial").trim() || undefined;
      if (!adapterSerial && debugProbes.length === 1 && debugProbes[0]?.serial) {
        adapterSerial = debugProbes[0].serial;
        updateSettings({ adapterSerial });
        appendLog("reply", `selected only probe ${adapterSerial}`);
      } else if (!adapterSerial && debugProbes.length > 1) {
        reportError("multiple debug probes found; select one on /probes or set adapterSerial");
        setPage("probes");
        return;
      }

      if (!health?.openocd_connected) {
        report("quick start: starting OpenOCD", "info");
        const spawned = await client.openocdSpawn(openocdOptions(adapterSerial));
        if (!spawned.ok) {
          reportError(spawned.error ?? "OpenOCD failed to start", spawned);
          refreshHealth();
          return;
        }
        report(`OpenOCD started (pid ${spawned.pid})`, "reply", spawned);
      } else {
        report("quick start: using existing OpenOCD connection", "info");
      }
      refreshHealth();

      report("quick start: scanning ProbeStream RAM", "info");
      const discovered = await scanProbeStream();
      if (!discovered.attached) {
        reportError(discovered.error ?? "ProbeStream control block not found", discovered);
        refreshHealth();
        return;
      }
      report(`attached at 0x${(discovered.controlBlockAddr ?? 0).toString(16)} — up=${discovered.numUp} down=${discovered.numDown}`, "reply", discovered);

      const stream = await client.streamStart();
      if (!stream.active) {
        reportError("stream failed to start", stream);
        refreshHealth();
        return;
      }
      report("streaming started", "reply", stream);
      setPage("stream");
      refreshHealth();
    } catch (err) {
      reportError(`quick start failed: ${errorMessage(err)}`);
      refreshHealth();
    }
  }, [appendLog, client, debugProbes, health?.openocd_connected, openocdOptions, refreshHealth, report, reportError, scanProbeStream, settings, updateSettings]);

  const rememberCommand = useCallback((channel: number, text: string, kind: CommandHistoryEntry["kind"]) => {
    const entry: CommandHistoryEntry = {
      id: nextRecentCommandIdRef.current++,
      ts: Date.now(),
      channel,
      text,
      kind,
    };
    setRecentCommands((commands) => [...commands.slice(-49), entry]);
    setRecentCommandsCollapsed(false);
  }, []);

  const setChannelToggle = useCallback((settingId: "graphChannels" | "statsChannels", channel: number, enabled: boolean) => {
    const channels = new Set(parseChannelSet(getString(settings, settingId)));
    if (enabled) channels.add(channel);
    else channels.delete(channel);
    updateSettings({ [settingId]: formatChannelSet(channels) });
  }, [settings, updateSettings]);

  const sendDownText = useCallback((channel: number, text: string, source: "send" | "terminal") => {
    const payload = btoa(text + "\n");
    appendLog("command", `${source === "terminal" ? "terminal " : ""}send <${text.length} chars> to ch${channel}`);
    client.streamSend(channel, payload)
      .then((r) => {
        rememberCommand(r.channel, text, "text");
        report(`sent ${r.written} bytes to ch${r.channel}`, "reply", r);
      })
      .catch((e) => reportError(`send failed: ${errorMessage(e)}`));
  }, [appendLog, client, rememberCommand, report, reportError]);

  const runCommand = useCallback((cmdLine: string) => {
    const cmd = (cmdLine.startsWith("/") ? cmdLine.slice(1) : cmdLine).trimStart();
    const [head, ...rest] = cmd.split(/\s+/);
    if (!head) return;
    appendLog("command", summarizeCommandLine(cmdLine));

    switch (head) {
      case "splash": setPage("splash"); appendLog("reply", "page: splash"); break;
      case "probes": setPage("probes"); appendLog("reply", "page: probes"); break;
      case "stream": setPage("stream"); appendLog("reply", "page: stream"); break;
      case "terminal": {
        const arg = (rest[0] ?? "0").toLowerCase();
        if (arg === "end" || arg === "exit") {
          setTerminalMode(false);
          setPage("stream");
          report("terminal mode off", "reply");
        } else {
          const value = arg === "enter" ? (rest[1] ?? "0") : arg;
          const ch = parseInt(value, 10);
          if (!Number.isFinite(ch) || ch < 0) {
            report("usage: /terminal [channel]|end|exit", "error");
            break;
          }
          setDownChannel(ch);
          setTerminalMode(true);
          setPage("stream");
          report(`terminal mode active — down:ch${ch}`, "reply");
        }
        break;
      }
      case "settings": setPage("settings"); appendLog("reply", "page: settings"); break;
      case "log":
      case "logs": setPage("log"); appendLog("reply", "page: log"); break;
      case "help":
        setHelpOpen(true);
        appendLog("reply", "help opened");
        break;
      case "?":
        setPageHelpOpen(true);
        appendLog("reply", `${page} help opened`);
        break;
      case "quit":
      case "exit":
        onQuit();
        break;
      case "copy": {
        const which = (rest[0] ?? "log").toLowerCase();
        const limit = parseInt(rest[1] ?? "", 10);
        let text = "";
        if (which === "log" || which === "logs" || which === "") {
          const slice = Number.isFinite(limit) && limit > 0 ? logEntries.slice(-limit) : logEntries;
          text = slice.map((e) => {
            const ts = new Date(e.ts).toISOString();
            const detail = e.detail ? `\n    ${e.detail}` : "";
            return `${ts} ${e.kind} ${e.message}${detail}`;
          }).join("\n");
        } else if (which === "errors") {
          text = logEntries.filter((e) => e.kind === "error").map((e) => `${new Date(e.ts).toISOString()} ${e.message}${e.detail ? "\n    " + e.detail : ""}`).join("\n");
        } else if (which === "last") {
          const last = logEntries[logEntries.length - 1];
          text = last ? `${new Date(last.ts).toISOString()} ${last.kind} ${last.message}${last.detail ? "\n    " + last.detail : ""}` : "";
        } else {
          report("usage: /copy [log|errors|last] [limit]", "error");
          break;
        }
        if (!text) { report("nothing to copy", "info"); break; }
        copyToClipboard(text).then((r) => {
          if (r.ok) report(`copied ${text.length} chars via ${r.tool}`, "reply");
          else report(r.error ?? "clipboard failed", "error");
        });
        break;
      }
      case "quickstart":
        setQuickStartOpen(true);
        appendLog("reply", "quick start guide opened");
        break;
      case "start":
        quickStartStreaming();
        break;
      case "stream-start":
        client.streamStart()
          .then((s) => report(s.active ? "streaming started" : "stream failed to start", s.active ? "reply" : "error", s))
          .catch((e) => reportError(`stream-start failed: ${errorMessage(e)}`));
        break;
      case "stop":
        client.streamStop()
          .then((s) => report("streaming stopped", "reply", s))
          .catch((e) => reportError(`stop failed: ${errorMessage(e)}`));
        break;
      case "discover":
        report("discovering debug probes...", "info");
        refreshProbes()
          .then((result) => {
            if (!result) return;
            if (result.probes.length === 0) report(result.error ?? "no debug probes found", "error", result.tools);
            else report(`found ${result.probes.length} debug probe${result.probes.length === 1 ? "" : "s"}`, "reply", result.probes);
            setPage("probes");
          });
        break;
      case "scan":
        report("scanning ProbeStream RAM...", "info");
        scanProbeStream()
          .then((r) => {
            if (r.attached) {
              report(`attached at 0x${(r.controlBlockAddr ?? 0).toString(16)} — up=${r.numUp} down=${r.numDown}`, "reply", r);
            } else {
              report(r.error ?? "control block not found", "error", r);
            }
          })
          .catch((e) => reportError(`scan failed: ${errorMessage(e)}`));
        break;
      case "attach": {
        const a = parseAddr(rest[0]);
        if (!Number.isFinite(a)) { report("usage: /attach <addr>", "error"); break; }
        client.attach(a)
          .then((r) => {
            if (r.attached) report(`attached at 0x${a.toString(16)}`, "reply", r);
            else report(r.error ?? "attach failed", "error", r);
          })
          .catch((e) => reportError(`attach failed: ${errorMessage(e)}`));
        break;
      }
      case "openocd": {
        if (rest[0] === "start") {
          report("spawning OpenOCD...", "info");
          client.openocdSpawn(openocdOptions())
            .then((r) => {
              if (r.ok) report(`OpenOCD started (pid ${r.pid})`, "reply", r);
              else report(r.error ?? "spawn failed", "error", r);
              refreshHealth();
            })
            .catch((e) => reportError(`openocd spawn: ${errorMessage(e)}`));
        } else if (rest[0] === "connect") {
          const host = getString(settings, "tclHost") || undefined;
          const port = parseInt(getString(settings, "tclPort"), 10) || undefined;
          client.openocdConnect(host, port)
            .then((r) => {
              if (r.ok) report(`OpenOCD connected at ${host ?? "localhost"}:${port ?? 6666}`, "reply", r);
              else report(r.error ?? "connect failed", "error", r);
              refreshHealth();
            })
            .catch((e) => reportError(`openocd connect: ${errorMessage(e)}`));
        } else if (rest[0] === "stop") {
          client.openocdStop()
            .then((r) => {
              report("OpenOCD stopped", "reply", r);
              refreshHealth();
            })
            .catch((e) => reportError(`stop failed: ${errorMessage(e)}`));
        } else {
          report("usage: /openocd start|connect|stop", "error");
        }
        break;
      }
      case "send": {
        const text = rest.join(" ");
        if (!text) { report("usage: /send <text>", "error"); break; }
        sendDownText(downChannel, text, "send");
        break;
      }
      case "send-hex": {
        const hex = rest.join("");
        if (!hex) { report("usage: /send-hex <hex>", "error"); break; }
        client.streamSendHex(downChannel, hex)
          .then((r) => {
            rememberCommand(r.channel, hex, "hex");
            report(`sent ${r.written} bytes to ch${r.channel}`, "reply", r);
          })
          .catch((e) => reportError(`send-hex failed: ${errorMessage(e)}`));
        break;
      }
      case "channel": {
        const target = (rest[0] ?? "").toLowerCase();
        if (target === "merge" || target === "all") {
          setChannelLayout("merge");
          report("stream view: merged channels", "reply");
          break;
        }
        if (target === "split") {
          setChannelLayout("split");
          report(`stream view: split channels up to ${getString(settings, "maxStreamSplits")}`, "reply");
          break;
        }
        if (target === "single") {
          const n = rest[1] !== undefined ? parseInt(rest[1], 10) : selectedChannel;
          if (!Number.isFinite(n) || n < 0) { report("usage: /channel single [n]", "error"); break; }
          setSelectedChannel(n);
          setChannelLayout("single");
          report(`viewing channel ${n}`, "reply");
          break;
        }
        const n = parseInt(target, 10);
        if (!Number.isFinite(n) || n < 0) { report("usage: /channel <n>|merge|split", "error"); break; }
        const action = (rest[1] ?? "").toLowerCase();
        if (action === "graph-on" || action === "graph-off" || action === "stats-on" || action === "stats-off") {
          const graphAction = action.startsWith("graph");
          const enabled = action.endsWith("on");
          setChannelToggle(graphAction ? "graphChannels" : "statsChannels", n, enabled);
          report(`channel ${n} ${graphAction ? "graph" : "stats"} ${enabled ? "enabled" : "disabled"}${enabled ? " — active when channel type is numeric" : ""}`, "reply");
          setPage("stream");
          break;
        }
        if (action) { report("usage: /channel <n> [graph-on|graph-off|stats-on|stats-off]", "error"); break; }
        setSelectedChannel(n);
        setChannelLayout("single");
        report(`viewing channel ${n}`, "reply");
        break;
      }
      case "recent": {
        const action = (rest[0] ?? "toggle").toLowerCase();
        if (action === "show" || action === "open") {
          setRecentCommandsCollapsed(false);
          report("recent command panel shown", "reply");
        } else if (action === "hide" || action === "close") {
          setRecentCommandsCollapsed(true);
          report("recent command panel hidden", "reply");
        } else if (action === "clear") {
          setRecentCommands([]);
          report("recent command history cleared", "reply");
        } else if (action === "toggle") {
          setRecentCommandsCollapsed((collapsed) => !collapsed);
          report("recent command panel toggled", "reply");
        } else {
          report("usage: /recent show|hide|toggle|clear", "error");
        }
        break;
      }
      case "mode": {
        const m = (rest[0] ?? "").toLowerCase();
        if (m === "raw" || m === "hex" || m === "ascii" || m === "line") {
          setDisplayMode(m);
          report(`display mode: ${m}`, "reply");
        } else {
          report("usage: /mode raw|hex|ascii|line", "error");
        }
        break;
      }
      case "clear":
      case "clearstream":
      case "clear-stream":
      case "clearstreams":
      case "clear-streams":
        clearStream();
        break;
      case "clearlog":
      case "clear-log":
      case "clearlogs":
      case "clear-logs": {
        clearLog();
        setFlash("log cleared");
        break;
      }
      case "capture": {
        if (rest[0] === "on") {
          client.captureStart(
            getString(settings, "capturePath") || undefined,
            getString(settings, "captureFormat") || undefined,
          ).then((s) => report("capture started", "reply", s))
            .catch((e) => reportError(`capture failed: ${errorMessage(e)}`));
        } else if (rest[0] === "off") {
          client.captureStop()
            .then((s) => report("capture stopped", "reply", s))
            .catch((e) => reportError(`capture stop: ${errorMessage(e)}`));
        } else if (rest[0] === "path") {
          updateSettings({ capturePath: rest.slice(1).join(" ") });
          report(`capture path: ${rest.slice(1).join(" ")}`, "reply");
        } else if (rest[0] === "format") {
          const fmt = rest[1];
          if (fmt === "raw" || fmt === "text" || fmt === "jsonl") {
            updateSettings({ captureFormat: fmt });
            report(`capture format: ${fmt}`, "reply");
          } else {
            report("usage: /capture format raw|text|jsonl", "error");
          }
        } else {
          report("usage: /capture on|off|path <file>|format <fmt>", "error");
        }
        break;
      }
      case "set": {
        const key = rest[0];
        const value = rest.slice(1).join(" ");
        if (!key || value === "") { report("usage: /set <key> <value>", "error"); break; }
        let parsed: unknown = value;
        if (value === "true") parsed = true;
        else if (value === "false") parsed = false;
        else if (/^\d+$/.test(value)) parsed = value; // keep as string for select fields
        updateSettings({ [key]: parsed });
        report(`${key} = ${value}`, "reply");
        break;
      }
      default:
        report(`unknown command: /${head}`, "error");
    }
  }, [appendLog, clearLog, clearStream, client, downChannel, logEntries, onQuit, openocdOptions, page, quickStartStreaming, refreshHealth, refreshProbes, rememberCommand, report, reportError, scanProbeStream, selectedChannel, sendDownText, setChannelToggle, settings, updateSettings]);

  const onSubmit = useCallback((line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (terminalMode && trimmed.startsWith("//")) {
      sendDownText(downChannel, trimmed.slice(1), "terminal");
      return;
    }
    if (trimmed.startsWith("/")) {
      runCommand(trimmed);
      return;
    }
    if (terminalMode && page === "stream") {
      sendDownText(downChannel, trimmed, "terminal");
    }
  }, [downChannel, page, runCommand, sendDownText, terminalMode]);

  // Global keyboard handler
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      const now = Date.now();
      if (now - quitArmedRef.current < 2000) {
        onQuit();
        return;
      }
      quitArmedRef.current = now;
      report("press Ctrl+C again to quit  ·  use /copy to yank the log", "info");
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (key.eventType === "release") return;

    if (
      !promptInputActive && !helpOpen && !pageHelpOpen && !switcherOpen && !completerActive &&
      !key.ctrl && !key.meta && !key.option &&
      (key.sequence === "?" || key.name === "?")
    ) {
      setPageHelpOpen(true);
      key.preventDefault(); key.stopPropagation();
      return;
    }

    if (
      !promptInputActive && !helpOpen && !pageHelpOpen && !switcherOpen && !completerActive &&
      !key.ctrl && !key.meta && !key.option && isSlashKey(key)
    ) {
      setPromptActivationInsertsSlash(promptEmpty);
      setPromptActivationToken((t) => t + 1);
      setPromptInputActive(true);
      key.preventDefault(); key.stopPropagation();
      return;
    }

    if (
      key.ctrl && !key.shift && !key.meta && !key.option &&
      !helpOpen && !pageHelpOpen && !quickStartOpen &&
      (key.name === "right" || key.name === "left")
    ) {
      const dir = key.name === "right" ? 1 : -1;
      const n = SWITCHER_PAGES.length;
      const cur = switcherOpen
        ? switcherIdx
        : Math.max(0, SWITCHER_PAGES.findIndex((p) => p.id === page));
      const next = (cur + dir + n) % n;
      const target = SWITCHER_PAGES[next];
      if (target) setPage(target.id as PageId);
      setSwitcherIdx(next);
      setSwitcherOpen(true);
      if (promptInputActive) setPromptInputActive(false);
      key.preventDefault(); key.stopPropagation();
      return;
    }
    if (switcherOpen && (key.name === "return" || key.name === "escape")) {
      setSwitcherOpen(false);
      key.preventDefault(); key.stopPropagation();
    }
  }, { release: true });

  const promptChromeOpen = promptInputActive || completerActive;
  const pageInputActive = !helpOpen && !pageHelpOpen && !quickStartOpen && !promptChromeOpen && !switcherOpen && !confirmAction;

  return (
    <box style={{ flexDirection: "column", backgroundColor: theme.bg, flexGrow: 1 }}>
      {/* Top status bar */}
      <box style={{
        flexDirection: "row", flexShrink: 0,
        backgroundColor: theme.surfaceVariant,
        paddingLeft: 1, paddingRight: 1,
      }}>
        <text style={{ fg: theme.accent }} content=" ProbeStream " />
        <text style={{ fg: theme.muted }} content="│ sidecar " />
        <text style={{ fg: theme.textDim }} content={client.baseUrl} />
        <text style={{ fg: health ? theme.ok : theme.muted }} content={health ? "  ●" : "  ?"} />
        <text style={{ fg: theme.muted, flexGrow: 1 }} content={`  │ ${page}${terminalMode && page === "stream" ? `  TERMINAL ch${downChannel}` : terminalMode ? `  (terminal ch${downChannel} suspended)` : ""}`} />
        {health?.openocd_connected ? (
          <text style={{ fg: theme.ok }} content="OCD " />
        ) : (
          <text style={{ fg: theme.muted }} content="OCD " />
        )}
        {health?.probestream_attached ? (
          <text style={{ fg: theme.ok }} content="PS " />
        ) : (
          <text style={{ fg: theme.muted }} content="PS " />
        )}
        {health?.streaming ? (
          <text style={{ fg: theme.accent }} content="STREAM " />
        ) : null}
        {error ? <text style={{ fg: theme.error }} content={` ${error.slice(0, 50)} `} /> : null}
      </box>

      {/* Page body */}
      <box style={{
        flexDirection: "column", flexGrow: 1, flexShrink: 1,
        minHeight: 0, overflow: "hidden",
        opacity: promptChromeOpen ? 0.48 : 1,
      }}>
        {page === "splash" ? (
          <SplashPage
            health={health}
            active={pageInputActive}
            probes={debugProbes}
            probeDiscovery={probeDiscovery}
            probeScanBusy={probeScanBusy}
            onRefreshProbes={() => { refreshProbes().catch(() => { }); }}
            onQuickStart={quickStartStreaming}
          />
        ) : page === "probes" ? (
          <ProbesPage
            client={client}
            active={pageInputActive}
            probes={debugProbes}
            probeDiscovery={probeDiscovery}
            onRefreshProbes={() => { refreshProbes().catch(() => { }); }}
            onSelectProbe={(probe) => {
              if (!probe.serial) {
                report("selected probe has no serial", "error", probe);
                return;
              }
              updateSettings({ adapterSerial: probe.serial });
              report(`adapterSerial = ${probe.serial}`, "reply");
            }}
            selectedProbeSerial={getString(settings, "adapterSerial")}
          />
        ) : page === "stream" ? (
          <StreamPage
            client={client}
            active={pageInputActive}
            displayMode={displayMode}
            selectedChannel={selectedChannel}
            channelLayout={channelLayout}
            maxVisibleChannels={parseInt(getString(settings, "maxStreamSplits"), 10) || 2}
            autoscroll={getBool(settings, "autoscroll")}
            chunkHistoryPerChannel={parseInt(getString(settings, "chunkHistoryPerChannel"), 10) || 500}
            graphWindowSize={parseInt(getString(settings, "graphWindowSize"), 10) || 256}
            graphEnabledChannels={parseChannelSet(getString(settings, "graphChannels"))}
            statsEnabledChannels={parseChannelSet(getString(settings, "statsChannels"))}
            terminalMode={terminalMode}
            downChannel={downChannel}
            recentCommands={recentCommands}
            recentCommandsCollapsed={recentCommandsCollapsed}
            clearSignal={streamClearSignal}
          />
        ) : page === "settings" ? (
          <SettingsPage active={pageInputActive} settings={settings} onChange={updateSettings} />
        ) : page === "log" ? (
          <LogPage active={pageInputActive} entries={logEntries} onClear={clearLog} />
        ) : null}
      </box>

      <QuickStartModal
        open={quickStartOpen}
        onClose={(doNotShow) => {
          setQuickStartOpen(false);
          if (doNotShow) {
            const local = loadLocalSettings();
            saveLocalSettings({ ...local, quickStartSeen: "true" });
          }
        }}
      />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <PageHelpModal open={pageHelpOpen} page={page} onClose={() => setPageHelpOpen(false)} />
      <PageSwitcher open={switcherOpen} pages={SWITCHER_PAGES} selected={switcherIdx} />

      {confirmAction ? (
        <ConfirmModal
          open={true}
          title={confirmAction.title}
          message={confirmAction.message}
          onConfirm={() => { confirmAction.action(); setConfirmAction(null); }}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}

      {/* Footer prompt */}
      <PromptBar
        enabled={!helpOpen && !pageHelpOpen && !quickStartOpen && !switcherOpen}
        inputActive={promptInputActive}
        activationToken={promptActivationToken}
        activationInsertsSlash={promptActivationInsertsSlash}
        onInputActiveChange={setPromptInputActive}
        onSubmit={onSubmit}
        slashCommands={SLASH_COMMANDS}
        onCompleterActive={setCompleterActive}
        onBufferChange={setPromptEmpty}
        allowFreeInput={terminalMode && page === "stream"}
        hint={
          flash ??
          (terminalMode && page === "stream"
            ? "type to send, / for commands, /terminal exit to leave"
            : "press / for commands — ? for help")
        }
      />
    </box>
  );
}
