import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { fg, StyledText } from "@opentui/core";
import { isTabKey } from "../keyboard.ts";
import { theme } from "../theme.ts";
import { Panel } from "../components/Panel.tsx";
import { MetricStrip, type Metric } from "../components/MetricStrip.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import type { BridgeClient } from "../bridge/client.ts";
import type { StreamBatch, StreamStatus, CaptureStatus } from "../bridge/types.ts";
import {
  type DisplayMode,
  type StreamChunk,
  ChannelChunkStore,
  decodeBase64,
  formatBytes,
  formatByteCount,
  formatRate,
  formatTimestamp,
} from "../decoders/index.ts";
import {
  NumericRingBuffer,
  RunningStats,
  channelTypeLabel,
  decodeNumericSamples,
  formatNumericSamples,
  formatGraphNumber,
  isGraphableChannelType,
  renderAreaGraph,
} from "../graphing.ts";

interface Props {
  client: BridgeClient;
  active: boolean;
  displayMode: DisplayMode;
  selectedChannel: number;
  channelLayout: StreamChannelLayout;
  maxVisibleChannels: number;
  autoscroll: boolean;
  chunkHistoryPerChannel: number;
  graphWindowSize: number;
  graphEnabledChannels: number[];
  statsEnabledChannels: number[];
  terminalMode: boolean;
  downChannel: number;
  recentCommands: CommandHistoryEntry[];
  recentCommandsCollapsed: boolean;
  clearSignal: number;
}

export type StreamChannelLayout = "single" | "merge" | "split";

/**
 * Build a single styled row from the head + body layers of an area chart.
 * Head cells (the curve edge) get the bright colour; body cells (the fill
 * below the curve) get the dim colour. Spaces stay uncoloured. Consecutive
 * cells with the same colour are merged into one chunk to keep the chunk
 * count small.
 */
function composeAreaRow(head: string, body: string, headColor: string, bodyColor: string): StyledText {
  const len = Math.max(head.length, body.length);
  const chunks: { kind: "head" | "body" | "blank"; text: string }[] = [];
  let runKind: "head" | "body" | "blank" | null = null;
  let runStart = 0;
  const flush = (endIdx: number) => {
    if (runKind === null || endIdx <= runStart) return;
    const slice = runKind === "head"
      ? head.slice(runStart, endIdx)
      : runKind === "body"
        ? body.slice(runStart, endIdx)
        : " ".repeat(endIdx - runStart);
    chunks.push({ kind: runKind, text: slice });
  };
  for (let i = 0; i < len; i++) {
    const h = head[i] ?? " ";
    const b = body[i] ?? " ";
    const kind: "head" | "body" | "blank" = h !== " " ? "head" : b !== " " ? "body" : "blank";
    if (kind !== runKind) {
      flush(i);
      runKind = kind;
      runStart = i;
    }
  }
  flush(len);
  return new StyledText(chunks.map((c) => {
    if (c.kind === "head") return fg(headColor)(c.text);
    if (c.kind === "body") return fg(bodyColor)(c.text);
    return { __isChunk: true, text: c.text } as const;
  }));
}

export interface CommandHistoryEntry {
  id: number;
  ts: number;
  channel: number;
  text: string;
  kind: "text" | "hex";
}

/**
 * Hard cap on the number of `<text>` rows rendered per pane. The chunk store
 * keeps the user-configured history (chunkHistoryPerChannel) so capture +
 * scrollback context still cover that range, but rendering 500+ yoga-laid-out
 * children per pane stalls the UI once the rings fill. Empirically ~200 rows
 * keeps a generous scrollback while staying responsive at 30 Hz with three
 * panes at high message rates.
 */
const MAX_RENDERED_LINES = 200;

export function StreamPage({
  client,
  active,
  displayMode,
  selectedChannel,
  channelLayout,
  maxVisibleChannels,
  autoscroll,
  chunkHistoryPerChannel,
  graphWindowSize,
  graphEnabledChannels,
  statsEnabledChannels,
  terminalMode,
  downChannel,
  recentCommands,
  recentCommandsCollapsed,
  clearSignal,
}: Props) {
  const { width } = useTerminalDimensions();
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const bufferRef = useRef(new ChannelChunkStore(chunkHistoryPerChannel));
  const [renderSeq, setRenderSeq] = useState(0);
  const sseRef = useRef<{ close: () => void } | null>(null);
  const bytesRef = useRef(0);
  const [throughput, setThroughput] = useState(0);
  const graphBuffersRef = useRef(new Map<number, NumericRingBuffer>());
  const statsRef = useRef(new Map<number, RunningStats>());
  const channelTypesRef = useRef(new Map<number, number>());
  const previousStatsEnabledRef = useRef(new Set<number>());

  const graphEnabledSet = useMemo(() => new Set(graphEnabledChannels), [graphEnabledChannels.join(",")]);
  const statsEnabledSet = useMemo(() => new Set(statsEnabledChannels), [statsEnabledChannels.join(",")]);
  const graphEnabledSetRef = useRef(graphEnabledSet);
  const statsEnabledSetRef = useRef(statsEnabledSet);
  const graphWindowSizeRef = useRef(graphWindowSize);

  useEffect(() => {
    graphEnabledSetRef.current = graphEnabledSet;
  }, [graphEnabledSet]);

  useEffect(() => {
    statsEnabledSetRef.current = statsEnabledSet;
  }, [statsEnabledSet]);

  useEffect(() => {
    graphWindowSizeRef.current = graphWindowSize;
  }, [graphWindowSize]);

  useEffect(() => {
    bufferRef.current.setCapacity(chunkHistoryPerChannel);
  }, [chunkHistoryPerChannel]);

  useEffect(() => {
    bufferRef.current.clear();
    graphBuffersRef.current.clear();
    statsRef.current.clear();
    bytesRef.current = 0;
    rateSamplesRef.current = [];
    setThroughput(0);
    setRenderSeq((s) => s + 1);
  }, [clearSignal]);

  useEffect(() => {
    for (const channel of [...graphBuffersRef.current.keys()]) {
      if (!graphEnabledSet.has(channel)) graphBuffersRef.current.delete(channel);
    }
  }, [graphEnabledSet]);

  useEffect(() => {
    const previous = previousStatsEnabledRef.current;
    for (const channel of [...statsRef.current.keys()]) {
      if (!statsEnabledSet.has(channel)) statsRef.current.delete(channel);
    }
    for (const channel of statsEnabledSet) {
      if (!previous.has(channel)) statsRef.current.set(channel, new RunningStats());
    }
    previousStatsEnabledRef.current = new Set(statsEnabledSet);
    setRenderSeq((s) => s + 1);
  }, [statsEnabledSet]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [s, c] = await Promise.all([client.streamStatus(), client.captureStatus()]);
        if (!cancelled) { setStatus(s); setCaptureStatus(c); }
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [client]);

  // Sliding-window throughput: sample bytesRef once per second, diff against
  // a sample from ~2 s ago. This shows current rate, not a lifetime average
  // (which monotonically decays toward the mean and hides recent behaviour).
  const rateSamplesRef = useRef<{ t: number; bytes: number }[]>([]);
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const samples = rateSamplesRef.current;
      samples.push({ t: now, bytes: bytesRef.current });
      // Keep ~3 s of history.
      while (samples.length > 1 && now - samples[0].t > 3_000) samples.shift();
      if (samples.length >= 2) {
        const oldest = samples[0];
        const dt = (now - oldest.t) / 1000;
        if (dt > 0) setThroughput((bytesRef.current - oldest.bytes) / dt);
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBatch = useCallback((batch: StreamBatch) => {
    const data = decodeBase64(batch.payload);
    const type = batch.channelType;
    const graphSet = graphEnabledSetRef.current;
    const statsSet = statsEnabledSetRef.current;
    const previousType = channelTypesRef.current.get(batch.channel);
    if (type !== undefined && previousType !== undefined && previousType !== type) {
      graphBuffersRef.current.delete(batch.channel);
      statsRef.current.delete(batch.channel);
      if (statsSet.has(batch.channel)) statsRef.current.set(batch.channel, new RunningStats());
    }
    if (type !== undefined) channelTypesRef.current.set(batch.channel, type);

    const decoded = decodeNumericSamples(type, data);
    if (decoded.graphable && decoded.samples.length > 0) {
      if (graphSet.has(batch.channel)) {
        const capacity = Math.max(1, graphWindowSizeRef.current);
        let buffer = graphBuffersRef.current.get(batch.channel);
        if (!buffer || buffer.capacity !== capacity) {
          const next = new NumericRingBuffer(capacity);
          if (buffer) next.pushAll(buffer.toArray());
          buffer = next;
          graphBuffersRef.current.set(batch.channel, buffer);
        }
        buffer.pushAll(decoded.samples);
      }
      if (statsSet.has(batch.channel)) {
        let stats = statsRef.current.get(batch.channel);
        if (!stats) {
          stats = new RunningStats();
          statsRef.current.set(batch.channel, stats);
        }
        stats.pushAll(decoded.samples);
      }
    }

    const chunk: StreamChunk = {
      seq: batch.seq,
      ts: batch.ts,
      channel: batch.channel,
      data,
    };
    bufferRef.current.push(chunk);
    bytesRef.current += data.length;
    // Coalesce re-renders to ~30 Hz so high-rate batches don't queue
    // thousands of React updates and stall input.
    if (renderTimerRef.current == null) {
      renderTimerRef.current = setTimeout(() => {
        renderTimerRef.current = null;
        setRenderSeq((s) => s + 1);
      }, 33);
    }
  }, []);

  useEffect(() => {
    if (sseRef.current) sseRef.current.close();
    sseRef.current = client.streamEvents(onBatch);
    bytesRef.current = 0;
    rateSamplesRef.current = [];
    return () => { sseRef.current?.close(); sseRef.current = null; };
  }, [client, onBatch]);

  const allChunks = useMemo(() => {
    void renderSeq;
    // Merge view is only used for the merged display mode. Cap the merged
    // tail so we don't sort a 1500-element array every render once the
    // per-channel rings are full.
    return bufferRef.current.toArray(MAX_RENDERED_LINES);
  }, [renderSeq]);

  const knownChannels = useMemo(() => {
    void renderSeq;
    const seen = new Set<number>();
    for (const channel of status?.channels ?? []) seen.add(channel);
    for (const channel of bufferRef.current.channels()) seen.add(channel);
    if (seen.size === 0) seen.add(selectedChannel);
    return [...seen].sort((a, b) => a - b);
  }, [renderSeq, selectedChannel, status?.channels]);

  const splitChannels = useMemo(() => {
    const limit = Math.max(1, maxVisibleChannels);
    return knownChannels.slice(0, limit);
  }, [knownChannels, maxVisibleChannels]);

  const hiddenSplitChannels = Math.max(0, knownChannels.length - splitChannels.length);

  const visibleChunks = useMemo(() => {
    if (channelLayout === "merge") return allChunks;
    if (channelLayout === "split") {
      // Split mode renders each pane independently from byChannel(); this
      // merged-visible array isn't used for layout there. Return empty to
      // skip the work.
      return [];
    }
    void renderSeq;
    return bufferRef.current.byChannel(selectedChannel, MAX_RENDERED_LINES);
  }, [allChunks, channelLayout, renderSeq, selectedChannel]);

  const metrics: Metric[] = [
    { label: "status", value: status?.active ? "streaming" : "stopped", color: status?.active ? theme.ok : theme.muted },
    { label: "bytes", value: formatByteCount(status?.totalBytes ?? 0) },
    { label: "batches", value: String(status?.totalBatches ?? 0) },
    { label: "rate", value: formatRate(throughput), color: theme.accent },
    { label: "buffered", value: String(bufferRef.current.length) },
    { label: "mode", value: displayMode },
    { label: "view", value: channelLayout === "single" ? `ch${selectedChannel}` : channelLayout },
    { label: "input", value: terminalMode ? `TERMINAL ch${downChannel}` : "slash", color: terminalMode ? theme.ok : theme.muted },
  ];

  if (channelLayout === "split" && hiddenSplitChannels > 0) {
    metrics.push({ label: "hidden", value: String(hiddenSplitChannels), color: theme.warn });
  }

  if (recentCommands.length > 0) {
    metrics.push({ label: "recent", value: recentCommandsCollapsed ? "hidden" : String(recentCommands.length), color: theme.textDim });
  }

  if (captureStatus?.active) {
    metrics.push({ label: "capture", value: formatByteCount(captureStatus.bytesWritten), color: theme.warn });
  }

  const statusChannelInfo = status?.channelInfo ?? [];
  const channelTypeFor = useCallback((channel: number) => {
    const info = statusChannelInfo.find((item) => item.index === channel);
    return info?.channelType ?? channelTypesRef.current.get(channel);
  }, [statusChannelInfo]);

  const buildDisplayLines = useCallback((chunks: StreamChunk[], includeChannel: boolean) => {
    // Slice chunks first: most modes emit one line per chunk, so trimming the
    // input below the render cap means we don't format chunks we'll throw
    // away. `line` mode can yield multiple lines per chunk, so we still apply
    // a final tail-slice below as a safety net.
    const sliced = chunks.length > MAX_RENDERED_LINES
      ? chunks.slice(chunks.length - MAX_RENDERED_LINES)
      : chunks;
    const lines: string[] = [];
    for (const chunk of sliced) {
      const ts = formatTimestamp(chunk.ts);
      const type = channelTypeFor(chunk.channel);
      const numericContent = displayMode === "hex" ? null : formatNumericSamples(type, chunk.data);
      const content = numericContent ?? formatBytes(chunk.data, displayMode);
      const prefix = includeChannel ? `[ch ${chunk.channel}] ` : "";
      if (displayMode === "line") {
        for (const line of content.split("\n")) {
          if (line) lines.push(`${ts}  ${prefix}${line}`);
        }
      } else if (displayMode === "hex") {
        lines.push(`--- ${ts}  ${prefix}(${chunk.data.length} bytes) ---`);
        lines.push(content);
      } else {
        lines.push(`${ts}  ${prefix}${content}`);
      }
    }
    if (lines.length > MAX_RENDERED_LINES) {
      return lines.slice(lines.length - MAX_RENDERED_LINES);
    }
    return lines;
  }, [channelTypeFor, displayMode]);

  const displayLines = useMemo(
    () => buildDisplayLines(visibleChunks, channelLayout === "merge"),
    [buildDisplayLines, channelLayout, visibleChunks],
  );

  const splitLines = useMemo(() => {
    if (channelLayout !== "split") return [];
    void renderSeq;
    return splitChannels.map((channel) => ({
      channel,
      lines: buildDisplayLines(bufferRef.current.byChannel(channel, MAX_RENDERED_LINES), false),
    }));
  }, [buildDisplayLines, channelLayout, renderSeq, splitChannels]);

  const showRecentPanel = recentCommands.length > 0 && !recentCommandsCollapsed;

  // Focusable pane keys for Tab + [/] resize. Order matches the on-screen layout
  // left-to-right: split channel panes (or the single stream pane), then Recent.
  const paneKeys = useMemo(() => {
    const keys: string[] = [];
    if (channelLayout === "split") {
      for (const channel of splitChannels) keys.push(`ch${channel}`);
    } else {
      keys.push("stream");
    }
    if (showRecentPanel) keys.push("recent");
    return keys;
  }, [channelLayout, splitChannels, showRecentPanel]);

  const [focusedPaneIdx, setFocusedPaneIdx] = useState(0);
  const [paneSizes, setPaneSizes] = useState<Record<string, number>>({});

  // Keep focus index in range when the pane set shrinks/grows.
  useEffect(() => {
    setFocusedPaneIdx((idx) => (paneKeys.length === 0 ? 0 : Math.min(idx, paneKeys.length - 1)));
  }, [paneKeys.length]);

  const PANE_GROW_MIN = 1;
  const PANE_GROW_MAX = 20;
  const defaultGrowFor = useCallback((key: string): number => {
    if (key === "recent") return 3;
    // The stream/split area collectively gets `7` when Recent is shown so the
    // ratio reads as ~7/3. Within the split row each pane defaults to 1.
    if (key === "stream") return showRecentPanel ? 7 : 1;
    return 1;
  }, [showRecentPanel]);
  const growFor = useCallback((key: string): number => paneSizes[key] ?? defaultGrowFor(key), [paneSizes, defaultGrowFor]);
  const focusedKey = paneKeys[focusedPaneIdx];

  useKeyboard((key) => {
    // TEMP DEBUG: log every key seen on the Stream page so we can diagnose
    // why `[` / `]` weren't producing pane resizes.
    const dbg = (globalThis as unknown as { __probestreamDebug?: (m: string, d?: unknown) => void }).__probestreamDebug;
    if (dbg) {
      const k = key as Record<string, unknown>;
      dbg(`stream key`, {
        active,
        paneCount: paneKeys.length,
        focused: paneKeys[focusedPaneIdx],
        name: k.name, sequence: k.sequence, raw: k.raw,
        ctrl: k.ctrl, shift: k.shift, meta: k.meta, option: k.option,
        eventType: k.eventType,
      });
    }
    if (!active) return;
    if (paneKeys.length <= 1) return;
    if (key.ctrl || key.meta || key.option) return;
    if (isTabKey(key)) {
      const back = key.shift;
      setFocusedPaneIdx((idx) => {
        const n = paneKeys.length;
        return back ? (idx - 1 + n) % n : (idx + 1) % n;
      });
      (key as { preventDefault?: () => void; stopPropagation?: () => void }).preventDefault?.();
      (key as { preventDefault?: () => void; stopPropagation?: () => void }).stopPropagation?.();
      return;
    }
    // Match bracket keys via sequence OR name OR raw — different terminals /
    // kitty-vs-raw parsers populate these inconsistently for non-named keys.
    const seq = (key.sequence ?? "") as string;
    const name = (key.name ?? "") as string;
    const raw = ((key as { raw?: string }).raw ?? "") as string;
    const isOpen = seq === "[" || name === "[" || raw === "[";
    const isClose = seq === "]" || name === "]" || raw === "]";
    if (isOpen || isClose) {
      const delta = isClose ? 1 : -1;
      const target = paneKeys[focusedPaneIdx];
      if (!target) return;
      setPaneSizes((prev) => {
        const current = prev[target] ?? defaultGrowFor(target);
        const next = Math.max(PANE_GROW_MIN, Math.min(PANE_GROW_MAX, current + delta));
        if (next === current) return prev;
        return { ...prev, [target]: next };
      });
      // Prevent PromptBar from auto-activating terminal-mode free input on `[` / `]`.
      (key as { preventDefault?: () => void; stopPropagation?: () => void }).preventDefault?.();
      (key as { preventDefault?: () => void; stopPropagation?: () => void }).stopPropagation?.();
    }
  });

  const paneCount = channelLayout === "split" ? Math.max(1, splitChannels.length) : 1;
  // Use the live flexGrow ratio so a resized pane gets a wider graph too. We
  // mirror the actual flex layout below: outer row contains the split/stream
  // sub-row (flexGrow 7 when Recent is shown, else 1) and the Recent panel
  // (flexGrow growFor("recent")). This makes graph width track the real pane
  // border instead of drifting based on a hardcoded Recent width.
  const splitRowFlex = showRecentPanel ? 7 : 1;
  const recentFlex = showRecentPanel ? growFor("recent") : 0;
  const splitGrowTotal = channelLayout === "split"
    ? splitChannels.reduce((sum, ch) => sum + growFor(`ch${ch}`), 0) || paneCount
    : 1;
  const graphWidthFor = useCallback((key: string): number => {
    // Account for the outer container border + 1-cell padding.
    const usable = Math.max(20, width - 2);
    const splitAreaWidth = showRecentPanel
      ? Math.floor(usable * splitRowFlex / (splitRowFlex + recentFlex))
      : usable;
    if (channelLayout !== "split") return Math.max(18, splitAreaWidth - 6);
    const ratio = growFor(key) / splitGrowTotal;
    // -4 covers the Panel border (2) + the 1-cell padding inside the graph box on each side (2).
    return Math.max(18, Math.floor(splitAreaWidth * ratio) - 4);
  }, [channelLayout, growFor, recentFlex, showRecentPanel, splitGrowTotal, splitRowFlex, width]);

  const renderScrollLines = (lines: string[], focused = active) => (
    lines.length === 0 ? (
      <text style={{ fg: theme.muted, padding: 1 }} content="No data yet. Use /start to begin streaming, then /send mode 1 if your firmware needs a kick." />
    ) : (
      <scrollbox
        focused={focused}
        scrollY
        stickyScroll={autoscroll}
        stickyStart="bottom"
        scrollbarOptions={{
          showArrows: false,
          trackOptions: {
            backgroundColor: theme.surfaceVariant,
            foregroundColor: theme.accent,
          },
        }}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          backgroundColor: theme.surface,
        }}
        contentOptions={{
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        {lines.map((line, i) => (
          <text key={i} style={{ fg: theme.text, flexShrink: 0 }} content={line} />
        ))}
      </scrollbox>
    )
  );

  const renderGraphPane = (channel: number, paneKey: string) => {
    const type = channelTypeFor(channel);
    const typeLabel = channelTypeLabel(type);
    if (!isGraphableChannelType(type)) {
      return (
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 4, backgroundColor: theme.surfaceHigh, paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: theme.muted }} content={`graph inactive: ch${channel} is ${typeLabel}`} />
        </box>
      );
    }

    const buffer = graphBuffersRef.current.get(channel);
    const samples = buffer?.toArray() ?? [];
    const latest = buffer?.latest;
    const GRAPH_HEIGHT = 6;
    const AXIS_WIDTH = 7; // room for `-123.4`
    const chartWidth = Math.max(12, graphWidthFor(paneKey) - AXIS_WIDTH - 1);
    const layers = renderAreaGraph(samples, chartWidth, GRAPH_HEIGHT, latest !== undefined ? `last ${formatGraphNumber(latest)}` : undefined);
    return (
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: GRAPH_HEIGHT + 1, backgroundColor: theme.surfaceHigh, paddingLeft: 1, paddingRight: 1 }}>
        {samples.length === 0 ? (
          <text style={{ fg: theme.muted }} content={`graph waiting: ch${channel} ${typeLabel}`} />
        ) : (
          <>
            <text style={{ fg: theme.textDim, flexShrink: 0 }} content={`graph ch${channel} ${typeLabel}  n=${samples.length}/${Math.max(1, graphWindowSize)}`} />
            {layers.head.map((headLine, index) => (
              <box key={index} style={{ flexDirection: "row", flexShrink: 0 }}>
                <text style={{ fg: theme.textDim, flexShrink: 0 }} content={(layers.axis[index] ?? "").padStart(AXIS_WIDTH, " ") + " "} />
                <text style={{ flexShrink: 0 }} content={composeAreaRow(headLine, layers.body[index] ?? "", theme.accent, theme.primary)} />
              </box>
            ))}
          </>
        )}
      </box>
    );
  };

  const renderStatsPane = (channel: number) => {
    const type = channelTypeFor(channel);
    const typeLabel = channelTypeLabel(type);
    const stats = statsRef.current.get(channel);
    if (!isGraphableChannelType(type)) {
      return (
        <box style={{ flexDirection: "column", flexShrink: 0, height: 2, backgroundColor: theme.surfaceVariant, paddingLeft: 1 }}>
          <text style={{ fg: theme.muted }} content={`stats inactive: ch${channel} is ${typeLabel}`} />
        </box>
      );
    }
    if (!stats || stats.count === 0) {
      return (
        <box style={{ flexDirection: "column", flexShrink: 0, height: 2, backgroundColor: theme.surfaceVariant, paddingLeft: 1 }}>
          <text style={{ fg: theme.muted }} content={`stats waiting: ch${channel} ${typeLabel}`} />
        </box>
      );
    }
    return (
      <box style={{ flexDirection: "column", flexShrink: 0, height: 2, backgroundColor: theme.surfaceVariant, paddingLeft: 1 }}>
        <text style={{ fg: theme.secondary }} content={`stats ch${channel} n=${stats.count} mean=${formatGraphNumber(stats.mean)} min=${formatGraphNumber(stats.min)} max=${formatGraphNumber(stats.max)} sd=${formatGraphNumber(stats.stddev)}`} />
      </box>
    );
  };

  const renderChannelPane = (channel: number, title: string, lines: string[], paneKey: string, flexGrow: number) => {
    const graphEnabled = graphEnabledSet.has(channel);
    const statsEnabled = statsEnabledSet.has(channel);
    const focused = active && focusedKey === paneKey;
    return (
      <Panel key={channel} title={title} flexGrow={flexGrow} focused={focused}>
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
          <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
            {renderScrollLines(lines, focused)}
          </box>
          {graphEnabled ? renderGraphPane(channel, paneKey) : null}
          {statsEnabled ? renderStatsPane(channel) : null}
        </box>
      </Panel>
    );
  };

  const streamTitle = channelLayout === "merge"
    ? `Stream — merged ${knownChannels.map((ch) => `ch${ch}`).join(", ")} [${displayMode}]  ·  ↑/↓ PgUp/PgDn Home/End to scroll`
    : `Stream — ch${selectedChannel} [${displayMode}]  ·  ↑/↓ PgUp/PgDn Home/End to scroll`;

  const splitTitleSuffix = hiddenSplitChannels > 0 ? `  (${hiddenSplitChannels} hidden)` : "";

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <MetricStrip metrics={metrics} />
      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
        {channelLayout === "split" ? (
          <box style={{ flexDirection: "row", flexGrow: showRecentPanel ? 7 : 1, flexShrink: 1, minHeight: 0 }}>
            {splitLines.map(({ channel, lines }) => {
              const paneKey = `ch${channel}`;
              return renderChannelPane(
                channel,
                `Stream — ch${channel} [${displayMode}]${splitTitleSuffix}`,
                lines,
                paneKey,
                growFor(paneKey),
              );
            })}
          </box>
        ) : (
          renderChannelPane(selectedChannel, streamTitle, displayLines, "stream", growFor("stream"))
        )}
        {showRecentPanel ? (
          <Panel title="Recent" flexGrow={growFor("recent")} flexShrink={0} focused={active && focusedKey === "recent"}>
            <box style={{ flexDirection: "column", overflow: "hidden", padding: 1 }}>
              {recentCommands.slice(-20).map((cmd) => (
                <text
                  key={cmd.id}
                  style={{ fg: theme.textDim, flexShrink: 0 }}
                  content={`ch${cmd.channel}  ${cmd.kind === "hex" ? "hex " : ""}${cmd.text}`}
                />
              ))}
            </box>
          </Panel>
        ) : null}
      </box>
      {captureStatus?.active ? (
        <box style={{ flexDirection: "row", flexShrink: 0, height: 1, paddingLeft: 1, backgroundColor: theme.surfaceVariant }}>
          <StatusPill label="CAPTURE" status="warn" />
          <text style={{ fg: theme.textDim }} content={`${captureStatus.format}  ${captureStatus.path ?? ""}  ${formatByteCount(captureStatus.bytesWritten)}`} />
        </box>
      ) : null}
    </box>
  );
}
