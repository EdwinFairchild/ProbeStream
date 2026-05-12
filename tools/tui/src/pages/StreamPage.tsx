import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { theme } from "../theme.ts";
import { Panel } from "../components/Panel.tsx";
import { MetricStrip, type Metric } from "../components/MetricStrip.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import type { BridgeClient } from "../bridge/client.ts";
import type { StreamBatch, StreamStatus, CaptureStatus } from "../bridge/types.ts";
import {
  type DisplayMode,
  type StreamChunk,
  ChunkRingBuffer,
  decodeBase64,
  formatBytes,
  formatByteCount,
  formatRate,
  formatTimestamp,
} from "../decoders/index.ts";

interface Props {
  client: BridgeClient;
  active: boolean;
  displayMode: DisplayMode;
  selectedChannel: number;
  channelLayout: StreamChannelLayout;
  maxVisibleChannels: number;
  autoscroll: boolean;
  maxBufferedChunks: number;
  terminalMode: boolean;
  downChannel: number;
  recentCommands: CommandHistoryEntry[];
  recentCommandsCollapsed: boolean;
}

export type StreamChannelLayout = "single" | "merge" | "split";

export interface CommandHistoryEntry {
  id: number;
  ts: number;
  channel: number;
  text: string;
  kind: "text" | "hex";
}

export function StreamPage({
  client,
  active,
  displayMode,
  selectedChannel,
  channelLayout,
  maxVisibleChannels,
  autoscroll,
  maxBufferedChunks,
  terminalMode,
  downChannel,
  recentCommands,
  recentCommandsCollapsed,
}: Props) {
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const bufferRef = useRef(new ChunkRingBuffer(maxBufferedChunks));
  const [renderSeq, setRenderSeq] = useState(0);
  const sseRef = useRef<{ close: () => void } | null>(null);
  const bytesRef = useRef(0);
  const [throughput, setThroughput] = useState(0);

  useEffect(() => {
    bufferRef.current = new ChunkRingBuffer(maxBufferedChunks);
  }, [maxBufferedChunks]);

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
    return bufferRef.current.toArray();
  }, [renderSeq]);

  const knownChannels = useMemo(() => {
    const seen = new Set<number>();
    for (const channel of status?.channels ?? []) seen.add(channel);
    for (const chunk of allChunks) seen.add(chunk.channel);
    if (seen.size === 0) seen.add(selectedChannel);
    return [...seen].sort((a, b) => a - b);
  }, [allChunks, selectedChannel, status?.channels]);

  const splitChannels = useMemo(() => {
    const limit = Math.max(1, maxVisibleChannels);
    return knownChannels.slice(0, limit);
  }, [knownChannels, maxVisibleChannels]);

  const hiddenSplitChannels = Math.max(0, knownChannels.length - splitChannels.length);

  const visibleChunks = useMemo(() => {
    if (channelLayout === "merge") return allChunks;
    if (channelLayout === "split") {
      const visible = new Set(splitChannels);
      return allChunks.filter((chunk) => visible.has(chunk.channel));
    }
    return allChunks.filter((chunk) => chunk.channel === selectedChannel);
  }, [allChunks, channelLayout, selectedChannel, splitChannels]);

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

  const buildDisplayLines = useCallback((chunks: StreamChunk[], includeChannel: boolean) => {
    const lines: string[] = [];
    for (const chunk of chunks) {
      const ts = formatTimestamp(chunk.ts);
      const content = formatBytes(chunk.data, displayMode);
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
    const MAX_RENDERED_LINES = 500;
    if (lines.length > MAX_RENDERED_LINES) {
      return lines.slice(lines.length - MAX_RENDERED_LINES);
    }
    return lines;
  }, [displayMode]);

  const displayLines = useMemo(
    () => buildDisplayLines(visibleChunks, channelLayout === "merge"),
    [buildDisplayLines, channelLayout, visibleChunks],
  );

  const splitLines = useMemo(() => {
    if (channelLayout !== "split") return [];
    return splitChannels.map((channel) => ({
      channel,
      lines: buildDisplayLines(allChunks.filter((chunk) => chunk.channel === channel), false),
    }));
  }, [allChunks, buildDisplayLines, channelLayout, splitChannels]);

  const showRecentPanel = recentCommands.length > 0 && !recentCommandsCollapsed;

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
            {splitLines.map(({ channel, lines }) => (
              <Panel key={channel} title={`Stream — ch${channel} [${displayMode}]${splitTitleSuffix}`} flexGrow={1}>
                {renderScrollLines(lines, active && channel === splitChannels[0])}
              </Panel>
            ))}
          </box>
        ) : (
          <Panel title={streamTitle} flexGrow={showRecentPanel ? 7 : 1}>
            {renderScrollLines(displayLines)}
          </Panel>
        )}
        {showRecentPanel ? (
          <Panel title="Recent" flexGrow={3} flexShrink={0}>
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
