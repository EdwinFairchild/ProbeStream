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
