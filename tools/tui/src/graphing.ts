export const CHANNEL_TYPE_RAW = 0;
export const CHANNEL_TYPE_TEXT = 1;
export const CHANNEL_TYPE_ASCII_NUMBER = 2;
export const CHANNEL_TYPE_INT32 = 3;
export const CHANNEL_TYPE_UINT32 = 4;
export const CHANNEL_TYPE_FLOAT32 = 5;
export const CHANNEL_TYPE_FLOAT64 = 6;

const NUMERIC_TYPES = new Set([
  CHANNEL_TYPE_ASCII_NUMBER,
  CHANNEL_TYPE_INT32,
  CHANNEL_TYPE_UINT32,
  CHANNEL_TYPE_FLOAT32,
  CHANNEL_TYPE_FLOAT64,
]);

export function isGraphableChannelType(type: number | undefined): boolean {
  return type !== undefined && NUMERIC_TYPES.has(type);
}

export function channelTypeLabel(type: number | undefined): string {
  switch (type) {
    case CHANNEL_TYPE_TEXT: return "text";
    case CHANNEL_TYPE_ASCII_NUMBER: return "ascii-number";
    case CHANNEL_TYPE_INT32: return "int32";
    case CHANNEL_TYPE_UINT32: return "uint32";
    case CHANNEL_TYPE_FLOAT32: return "float32";
    case CHANNEL_TYPE_FLOAT64: return "float64";
    case CHANNEL_TYPE_RAW: return "raw";
    default: return "unknown";
  }
}

export function parseChannelSet(value: unknown): number[] {
  if (typeof value !== "string") return [];
  const out = new Set<number>();
  for (const token of value.split(/[\s,]+/)) {
    if (!token) continue;
    const channel = Number(token);
    if (Number.isInteger(channel) && channel >= 0) out.add(channel);
  }
  return [...out].sort((a, b) => a - b);
}

export function formatChannelSet(channels: Iterable<number>): string {
  return [...new Set(channels)]
    .filter((channel) => Number.isInteger(channel) && channel >= 0)
    .sort((a, b) => a - b)
    .join(",");
}

export interface NumericDecodeResult {
  samples: number[];
  graphable: boolean;
  error?: string;
}

export function decodeNumericSamples(type: number | undefined, data: Uint8Array): NumericDecodeResult {
  if (!isGraphableChannelType(type)) {
    return { samples: [], graphable: false, error: `channel type ${channelTypeLabel(type)} is not graphable` };
  }

  if (type === CHANNEL_TYPE_ASCII_NUMBER) return decodeAsciiNumbers(data);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = type === CHANNEL_TYPE_FLOAT64 ? 8 : 4;
  const sampleCount = Math.floor(data.byteLength / width);
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const offset = i * width;
    switch (type) {
      case CHANNEL_TYPE_INT32:
        samples.push(view.getInt32(offset, true));
        break;
      case CHANNEL_TYPE_UINT32:
        samples.push(view.getUint32(offset, true));
        break;
      case CHANNEL_TYPE_FLOAT32:
        samples.push(view.getFloat32(offset, true));
        break;
      case CHANNEL_TYPE_FLOAT64:
        samples.push(view.getFloat64(offset, true));
        break;
    }
  }

  const trailing = data.byteLength % width;
  return {
    samples: samples.filter(Number.isFinite),
    graphable: true,
    error: trailing > 0 ? `ignored ${trailing} trailing byte${trailing === 1 ? "" : "s"}` : undefined,
  };
}

function decodeAsciiNumbers(data: Uint8Array): NumericDecodeResult {
  let text = "";
  for (const byte of data) {
    if (byte > 0x7f) return { samples: [], graphable: true, error: "non-ASCII numeric payload" };
    text += String.fromCharCode(byte);
  }
  const trimmed = text.trim();
  if (!trimmed) return { samples: [], graphable: true };

  const tokenPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const tokens = trimmed.split(/[\s,]+/);
  const samples: number[] = [];
  for (const token of tokens) {
    if (!tokenPattern.test(token)) {
      return { samples: [], graphable: true, error: "payload is not strict numeric ASCII" };
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      return { samples: [], graphable: true, error: "numeric payload is not finite" };
    }
    samples.push(value);
  }
  return { samples, graphable: true };
}

export class NumericRingBuffer {
  private values: number[] = [];

  constructor(public readonly capacity: number) {}

  push(value: number): void {
    if (!Number.isFinite(value) || this.capacity <= 0) return;
    this.values.push(value);
    if (this.values.length > this.capacity) {
      this.values.splice(0, this.values.length - this.capacity);
    }
  }

  pushAll(values: readonly number[]): void {
    for (const value of values) this.push(value);
  }

  clear(): void {
    this.values = [];
  }

  toArray(): number[] {
    return [...this.values];
  }

  get length(): number {
    return this.values.length;
  }

  get latest(): number | undefined {
    return this.values[this.values.length - 1];
  }
}

export class RunningStats {
  count = 0;
  min = Infinity;
  max = -Infinity;
  private meanValue = 0;
  private m2 = 0;

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.count++;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    const delta = value - this.meanValue;
    this.meanValue += delta / this.count;
    const delta2 = value - this.meanValue;
    this.m2 += delta * delta2;
  }

  pushAll(values: readonly number[]): void {
    for (const value of values) this.push(value);
  }

  get mean(): number {
    return this.count > 0 ? this.meanValue : NaN;
  }

  get variance(): number {
    return this.count > 1 ? this.m2 / (this.count - 1) : 0;
  }

  get stddev(): number {
    return Math.sqrt(this.variance);
  }
}

export function formatGraphNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1000 || (abs > 0 && abs < 0.001)) return value.toExponential(2);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(abs >= 100 ? 1 : abs >= 10 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatNumericSamples(type: number | undefined, data: Uint8Array): string | null {
  const decoded = decodeNumericSamples(type, data);
  if (!decoded.graphable || decoded.samples.length === 0) return null;
  const text = decoded.samples.map(formatGraphNumber).join(" ");
  return decoded.error ? `${text}  (${decoded.error})` : text;
}

// Modern dot-style graph: braille sub-pixels (2x4 per terminal cell) drawn as
// a connected line of dots, like a scope trace. Reads as a clean dotted curve
// rather than a solid filled area. Single colour (we keep the head/body API
// for backwards compatibility, but `body` is always blank so the caller paints
// the dots in the bright accent colour).
//
// Each terminal cell can encode up to 8 dots:
//     1 4
//     2 5
//     3 6
//     7 8
// We rasterize a polyline between consecutive samples with Bresenham's
// algorithm in sub-pixel space so dense data becomes a continuous dotted line
// and sparse data stays as discrete dots.

const BRAILLE_BASE = 0x2800;
// BRAILLE_BIT[subY][subX]  with subY in 0..3, subX in 0..1
const BRAILLE_BIT: readonly (readonly number[])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export interface AreaGraphLayers {
  /** One string per row. The dotted curve, in bright colour. */
  head: string[];
  /** One string per row. Always blank — kept for API compatibility. */
  body: string[];
  /** Min/max axis ticks, one entry per row (most rows are empty). Caller can render in muted colour. */
  axis: string[];
  /** Numeric min/max actually plotted (after auto-scaling for flat series). */
  min: number;
  max: number;
}

function bucketSamplesSubpixel(samples: readonly number[], subWidth: number): (number | null)[] {
  const out = new Array<number | null>(subWidth).fill(null);
  if (samples.length === 0) return out;
  if (samples.length <= subWidth) {
    // Right-align so the latest sample lands at the right edge.
    const offset = subWidth - samples.length;
    for (let i = 0; i < samples.length; i++) out[offset + i] = samples[i]!;
    return out;
  }
  const ratio = samples.length / subWidth;
  for (let c = 0; c < subWidth; c++) {
    const start = Math.floor(c * ratio);
    const end = Math.max(start + 1, Math.floor((c + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let i = start; i < end && i < samples.length; i++) { sum += samples[i]!; n++; }
    out[c] = n > 0 ? sum / n : null;
  }
  return out;
}

export function renderAreaGraph(samples: readonly number[], width: number, height: number, latestLabel?: string): AreaGraphLayers {
  const W = Math.max(8, width);
  const H = Math.max(3, height);
  const SUB_X = 2;
  const SUB_Y = 4;
  const subW = W * SUB_X;
  const subH = H * SUB_Y;

  // Bitmask grid: one number per terminal cell.
  const grid: number[][] = Array.from({ length: H }, () => new Array<number>(W).fill(0));
  const blankRow = () => Array<string>(W).fill(" ");
  const body: string[] = Array.from({ length: H }, () => " ".repeat(W));
  const axis: string[] = Array.from({ length: H }, () => "");

  const buckets = bucketSamplesSubpixel(samples, subW);
  let min = Infinity;
  let max = -Infinity;
  for (const v of buckets) if (v != null) { if (v < min) min = v; if (v > max) max = v; }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return {
      head: Array.from({ length: H }, () => " ".repeat(W)),
      body, axis, min: 0, max: 0,
    };
  }
  const plotMin = min;
  const plotMax = max;
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;

  const valueToSubY = (v: number) => {
    const norm = (v - min) / range;
    const y = Math.round((1 - norm) * (subH - 1));
    return Math.max(0, Math.min(subH - 1, y));
  };

  const setDot = (sx: number, sy: number) => {
    if (sx < 0 || sx >= subW || sy < 0 || sy >= subH) return;
    const cellCol = sx >> 1;
    const cellRow = sy >> 2;
    grid[cellRow]![cellCol]! |= BRAILLE_BIT[sy & 3]![sx & 1]!;
  };

  // Connect consecutive non-null samples with a Bresenham line of dots.
  let prevX = -1;
  let prevY = -1;
  let latestSubX = -1;
  let latestSubY = -1;
  for (let x = 0; x < subW; x++) {
    const v = buckets[x];
    if (v == null) continue;
    const y = valueToSubY(v);
    if (prevX >= 0) {
      let x0 = prevX, y0 = prevY, x1 = x, y1 = y;
      const dx = Math.abs(x1 - x0);
      const sx = x0 < x1 ? 1 : -1;
      const dy = -Math.abs(y1 - y0);
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        setDot(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    } else {
      setDot(x, y);
    }
    prevX = x;
    prevY = y;
    latestSubX = x;
    latestSubY = y;
  }

  // Convert bitmask grid to braille glyphs.
  const head: string[][] = Array.from({ length: H }, blankRow);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const bits = grid[r]![c]!;
      if (bits !== 0) head[r]![c] = String.fromCharCode(BRAILLE_BASE + bits);
    }
  }

  // Latest-sample marker: replace its cell with a solid dot so it pops.
  if (latestSubX >= 0 && latestSubY >= 0) {
    const cellCol = latestSubX >> 1;
    const cellRow = latestSubY >> 2;
    head[cellRow]![cellCol] = "●";
  }

  // Right-aligned "last <value>" label pinned to the top row.
  if (latestLabel) {
    const label = ` ${latestLabel}`;
    const trimmed = label.length > W ? label.slice(0, W) : label;
    const start = Math.max(0, W - trimmed.length);
    const row = head[0]!;
    for (let i = 0; i < trimmed.length && start + i < W; i++) row[start + i] = trimmed[i]!;
  }

  axis[0] = formatGraphNumber(plotMax);
  axis[H - 1] = formatGraphNumber(plotMin);

  return {
    head: head.map((r) => r.join("")),
    body,
    axis,
    min: plotMin,
    max: plotMax,
  };
}

/** Backwards-compatible single-layer render: head + body merged into one string per row. */
export function renderGraphLines(samples: readonly number[], width: number, height: number, latestLabel?: string): string[] {
  const layers = renderAreaGraph(samples, width, height, latestLabel);
  const out: string[] = [];
  for (let r = 0; r < layers.head.length; r++) {
    const h = layers.head[r]!;
    const b = layers.body[r]!;
    let merged = "";
    for (let i = 0; i < h.length; i++) {
      const hc = h[i]!;
      merged += hc !== " " ? hc : b[i]!;
    }
    out.push(merged);
  }
  return out;
}