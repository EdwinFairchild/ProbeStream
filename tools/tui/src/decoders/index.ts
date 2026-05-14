export type DisplayMode = "raw" | "hex" | "ascii" | "line";

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function encodeBase64(data: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]!);
  return btoa(bin);
}

export function hexDump(bytes: Uint8Array, offset = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const addr = (offset + i).toString(16).padStart(8, "0");
    const hexParts: string[] = [];
    let ascii = "";
    for (let j = 0; j < 16; j++) {
      if (i + j < bytes.length) {
        const b = bytes[i + j]!;
        hexParts.push(b.toString(16).padStart(2, "0"));
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      } else {
        hexParts.push("  ");
        ascii += " ";
      }
    }
    const hex = hexParts.slice(0, 8).join(" ") + "  " + hexParts.slice(8).join(" ");
    lines.push(`${addr}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

export function toAscii(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0a) out += "\n";
    else if (b === 0x0d) continue; // strip CR
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "�";
  }
  return out;
}

export function rawSummary(bytes: Uint8Array): string {
  if (bytes.length === 0) return "(empty)";
  const preview = Array.from(bytes.slice(0, 32))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const suffix = bytes.length > 32 ? ` ... (${bytes.length} bytes)` : ` (${bytes.length} bytes)`;
  return preview + suffix;
}

export function formatBytes(bytes: Uint8Array, mode: DisplayMode): string {
  switch (mode) {
    case "raw":
      return rawSummary(bytes);
    case "hex":
      return hexDump(bytes);
    case "ascii":
      return toAscii(bytes);
    case "line":
      return toAscii(bytes);
  }
}

export interface StreamChunk {
  seq: number;
  ts: number;
  channel: number;
  data: Uint8Array;
}

export class LineAssembler {
  private partial = "";

  feed(text: string): string[] {
    const combined = this.partial + text;
    const lines = combined.split("\n");
    this.partial = lines.pop() ?? "";
    return lines;
  }

  flush(): string | null {
    if (this.partial.length === 0) return null;
    const line = this.partial;
    this.partial = "";
    return line;
  }
}

export class ChunkRingBuffer {
  private chunks: (StreamChunk | null)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.chunks = new Array(capacity).fill(null);
  }

  push(chunk: StreamChunk): void {
    this.chunks[this.head] = chunk;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.chunks.fill(null);
    this.head = 0;
    this.count = 0;
  }

  toArray(): StreamChunk[] {
    const out: StreamChunk[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const c = this.chunks[idx];
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * Returns up to the last `n` chunks in chronological order without
   * materialising the older portion of the ring.
   */
  tail(n: number): StreamChunk[] {
    const take = Math.min(this.count, Math.max(0, n));
    if (take === 0) return [];
    const out: StreamChunk[] = new Array(take);
    const start = this.count < this.capacity ? 0 : this.head;
    const offset = this.count - take;
    for (let i = 0; i < take; i++) {
      const idx = (start + offset + i) % this.capacity;
      const c = this.chunks[idx];
      if (c) out[i] = c;
    }
    return out;
  }

  get length(): number {
    return this.count;
  }

  totalBytes(): number {
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = ((this.count < this.capacity ? 0 : this.head) + i) % this.capacity;
      const c = this.chunks[idx];
      if (c) total += c.data.length;
    }
    return total;
  }
}

/**
 * Keeps a separate ring buffer per channel so a noisy channel can't evict
 * data on a quiet one. Each channel retains the most recent `capacityPerChannel`
 * chunks; older ones are dropped silently. This lets the TUI stream forever
 * without unbounded memory growth.
 */
export class ChannelChunkStore {
  private rings = new Map<number, ChunkRingBuffer>();
  private channelsCache: number[] | null = null;

  constructor(private capacityPerChannel: number) {}

  setCapacity(capacity: number): void {
    if (capacity === this.capacityPerChannel) return;
    this.capacityPerChannel = capacity;
    // Re-bucket existing chunks into new rings so the per-channel cap takes
    // effect immediately without losing the most recent data.
    const next = new Map<number, ChunkRingBuffer>();
    for (const [channel, ring] of this.rings) {
      const fresh = new ChunkRingBuffer(capacity);
      for (const chunk of ring.toArray()) fresh.push(chunk);
      next.set(channel, fresh);
    }
    this.rings = next;
  }

  push(chunk: StreamChunk): void {
    let ring = this.rings.get(chunk.channel);
    if (!ring) {
      ring = new ChunkRingBuffer(this.capacityPerChannel);
      this.rings.set(chunk.channel, ring);
      this.channelsCache = null;
    }
    ring.push(chunk);
  }

  clear(): void {
    this.rings.clear();
    this.channelsCache = null;
  }

  /** Sorted list of channel keys currently held. Cached between mutations. */
  channels(): number[] {
    if (this.channelsCache) return this.channelsCache;
    const list = [...this.rings.keys()].sort((a, b) => a - b);
    this.channelsCache = list;
    return list;
  }

  /**
   * Per-channel view. Returns at most `max` most-recent chunks for the channel
   * without merging or sorting other channels — O(min(max, ring.length)).
   */
  byChannel(channel: number, max?: number): StreamChunk[] {
    const ring = this.rings.get(channel);
    if (!ring) return [];
    if (max === undefined || max >= ring.length) return ring.toArray();
    return ring.tail(max);
  }

  /**
   * Merged view in seq order across all channels. When `max` is provided, only
   * the last `max` chunks (after merge) are materialised — we still pull the
   * tail of every per-channel ring (cheap), but we skip allocating the older
   * portion of the merged array.
   */
  toArray(max?: number): StreamChunk[] {
    if (this.rings.size === 0) return [];
    if (this.rings.size === 1) {
      // Fast path: single channel needs no sort.
      const ring = [...this.rings.values()][0]!;
      if (max === undefined || max >= ring.length) return ring.toArray();
      return ring.tail(max);
    }
    // Pull a per-channel tail bounded by `max` so we don't sort every chunk
    // when the caller only needs the tail.
    const perChannelCap = max ?? Number.POSITIVE_INFINITY;
    const out: StreamChunk[] = [];
    for (const ring of this.rings.values()) {
      const slice = perChannelCap >= ring.length ? ring.toArray() : ring.tail(perChannelCap);
      for (const chunk of slice) out.push(chunk);
    }
    out.sort((a, b) => a.seq - b.seq);
    if (max !== undefined && out.length > max) return out.slice(out.length - max);
    return out;
  }

  get length(): number {
    let total = 0;
    for (const ring of this.rings.values()) total += ring.length;
    return total;
  }

  totalBytes(): number {
    let total = 0;
    for (const ring of this.rings.values()) total += ring.totalBytes();
    return total;
  }
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export function formatByteCount(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}
