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
  /** One string per row. The curve outline (braille), in bright colour. */
  head: string[];
  /** One string per row. Filled area below the curve, rendered in dim colour. */
  body: string[];
  /** One string per row. Faint horizontal gridlines, rendered in muted colour. */
  grid: string[];
  /** Axis ticks (max / mid / min), one entry per row (most rows are empty). */
  axis: string[];
  /** Numeric min/max actually plotted (after auto-scaling for flat series). */
  min: number;
  max: number;
}

interface SubpixelBuckets {
  /** Mean (or only) value per sub-x column. `null` for empty columns. */
  mean: (number | null)[];
  /** Per-column min, only populated when the column aggregates >1 sample. */
  min: (number | null)[];
  /** Per-column max, only populated when the column aggregates >1 sample. */
  max: (number | null)[];
  /** True when at least one column aggregates more than one sample (envelope mode). */
  envelopeMode: boolean;
}

function bucketSamplesSubpixel(samples: readonly number[], subWidth: number): SubpixelBuckets {
  const mean = new Array<number | null>(subWidth).fill(null);
  const min = new Array<number | null>(subWidth).fill(null);
  const max = new Array<number | null>(subWidth).fill(null);
  if (samples.length === 0) return { mean, min, max, envelopeMode: false };
  if (samples.length === 1) {
    mean[subWidth - 1] = samples[0]!;
    return { mean, min, max, envelopeMode: false };
  }
  if (samples.length <= subWidth) {
    // Sparse data: place each sample at its proportional sub-x position so
    // the spline pass below has accurate control points to interpolate
    // between. No envelope needed — every column has at most one sample.
    const step = (subWidth - 1) / (samples.length - 1);
    for (let i = 0; i < samples.length; i++) {
      const sx = Math.round(i * step);
      mean[sx] = samples[i]!;
    }
    return { mean, min, max, envelopeMode: false };
  }
  // Dense data: each sub-x column aggregates several samples. Track
  // mean/min/max so the renderer can draw a min-max envelope (preserves the
  // visible amplitude of fast oscillations instead of averaging them away).
  const ratio = samples.length / subWidth;
  for (let c = 0; c < subWidth; c++) {
    const start = Math.floor(c * ratio);
    const end = Math.max(start + 1, Math.floor((c + 1) * ratio));
    let sum = 0;
    let n = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end && i < samples.length; i++) {
      const v = samples[i]!;
      sum += v;
      n++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (n > 0) {
      mean[c] = sum / n;
      min[c] = lo;
      max[c] = hi;
    }
  }
  return { mean, min, max, envelopeMode: true };
}

/**
 * Catmull-Rom spline interpolation across the sub-pixel column array. Replaces
 * the gaps between known sample points with a smooth curve so diagonal runs
 * read as actual curves instead of polyline jaggies.
 */
function interpolateSplineSubpixel(buckets: (number | null)[]): (number | null)[] {
  const N = buckets.length;
  // Collect known control points.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < N; i++) {
    const v = buckets[i];
    if (v != null) { xs.push(i); ys.push(v); }
  }
  if (xs.length < 2) return buckets.slice();

  const out: (number | null)[] = new Array<number | null>(N).fill(null);
  // Pad with virtual endpoints so the spline has neighbours at the boundaries.
  const px = (idx: number) => xs[Math.max(0, Math.min(xs.length - 1, idx))]!;
  const py = (idx: number) => ys[Math.max(0, Math.min(ys.length - 1, idx))]!;

  for (let seg = 0; seg < xs.length - 1; seg++) {
    const x0 = px(seg - 1), y0 = py(seg - 1);
    const x1 = px(seg),     y1 = py(seg);
    const x2 = px(seg + 1), y2 = py(seg + 1);
    const x3 = px(seg + 2), y3 = py(seg + 2);
    const segStart = x1;
    const segEnd = x2;
    if (segEnd <= segStart) { out[segStart] = y1; continue; }
    for (let xi = segStart; xi <= segEnd; xi++) {
      const t = (xi - segStart) / (segEnd - segStart);
      // Centripetal Catmull-Rom on uniform parameterisation (good enough for
      // visual smoothing and cheap to compute).
      const t2 = t * t;
      const t3 = t2 * t;
      const v =
        0.5 * (
          (2 * y1) +
          (-y0 + y2) * t +
          (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
          (-y0 + 3 * y1 - 3 * y2 + y3) * t3
        );
      // Avoid masking real later samples: only write null cells, plus the
      // segment start anchor.
      if (out[xi] == null) out[xi] = v;
      // Suppress unused-var warning for x0/x3 which act only via y0/y3.
      void x0; void x3;
    }
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
  const body: string[][] = Array.from({ length: H }, blankRow);
  const gridLayer: string[][] = Array.from({ length: H }, blankRow);
  const axis: string[] = Array.from({ length: H }, () => "");

  const bucketed = bucketSamplesSubpixel(samples, subW);
  // Range from the *known* extremes (min in envelope mode, mean otherwise).
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < subW; i++) {
    const lo = bucketed.envelopeMode ? bucketed.min[i] : bucketed.mean[i];
    const hi = bucketed.envelopeMode ? bucketed.max[i] : bucketed.mean[i];
    if (lo != null && lo < min) min = lo;
    if (hi != null && hi > max) max = hi;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return {
      head: Array.from({ length: H }, () => " ".repeat(W)),
      body: body.map((r) => r.join("")),
      grid: gridLayer.map((r) => r.join("")),
      axis,
      min: 0,
      max: 0,
    };
  }
  const plotMin = min;
  const plotMax = max;
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;

  // Smooth pass: only meaningful for sparse data. In envelope mode the
  // bucket means already represent the trend; we use min/max envelopes
  // instead of interpolation.
  const trace = bucketed.envelopeMode ? bucketed.mean : interpolateSplineSubpixel(bucketed.mean);

  const valueToSubYFractional = (v: number) => {
    const norm = (v - min) / range;
    const y = (1 - norm) * (subH - 1);
    return Math.max(0, Math.min(subH - 1, y));
  };

  const setDot = (sx: number, sy: number) => {
    if (sx < 0 || sx >= subW || sy < 0 || sy >= subH) return;
    const cellCol = sx >> 1;
    const cellRow = sy >> 2;
    grid[cellRow]![cellCol]! |= BRAILLE_BIT[sy & 3]![sx & 1]!;
  };

  let latestSubX = -1;
  let latestSubY = -1;

  if (bucketed.envelopeMode) {
    // Waveform-style: each column draws a vertical strip from its bucket's
    // min to its bucket's max. This preserves the visible amplitude of fast
    // oscillations even when many samples collapse into a single column.
    let prevTop = -1;
    let prevBot = -1;
    for (let x = 0; x < subW; x++) {
      const lo = bucketed.min[x];
      const hi = bucketed.max[x];
      if (lo == null || hi == null) {
        prevTop = -1;
        prevBot = -1;
        continue;
      }
      const top = Math.round(valueToSubYFractional(hi));
      const bot = Math.round(valueToSubYFractional(lo));
      const a = Math.min(top, bot);
      const b = Math.max(top, bot);
      for (let y = a; y <= b; y++) setDot(x, y);
      // Bridge to the neighbouring column's strip so the trace stays
      // continuous when the signal moves faster than one pixel per column.
      if (prevTop >= 0 && prevBot >= 0) {
        const pa = Math.min(prevTop, prevBot);
        const pb = Math.max(prevTop, prevBot);
        if (a > pb) for (let y = pb; y <= a; y++) setDot(x, y);
        else if (b < pa) for (let y = b; y <= pa; y++) setDot(x, y);
      }
      prevTop = top;
      prevBot = bot;
      latestSubX = x;
      latestSubY = Math.round(valueToSubYFractional(bucketed.mean[x]!));
    }
  } else {
    // Sparse / spline-smoothed trace. Plot one dot per sub-x with a small
    // anti-aliasing companion so diagonals don't stair-step.
    for (let x = 0; x < subW; x++) {
      const v = trace[x];
      if (v == null) continue;
      const yFrac = valueToSubYFractional(v);
      const y = Math.round(yFrac);
      setDot(x, y);
      const frac = yFrac - Math.floor(yFrac);
      if (frac > 0.15 && frac < 0.85) {
        const neighbour = frac < 0.5 ? Math.floor(yFrac) : Math.ceil(yFrac);
        if (neighbour !== y) setDot(x, neighbour);
      }
      if (bucketed.mean[x] != null) { latestSubX = x; latestSubY = y; }
    }
  }

  // Faint horizontal gridline at the midline. Drawn only in cells the curve
  // doesn't already touch so it stays in the background.
  const gridRows = H >= 5 ? [Math.floor(H / 2)] : [];
  for (const gr of gridRows) {
    if (gr <= 0 || gr >= H - 1) continue;
    for (let c = 0; c < W; c++) {
      if (grid[gr]![c]! !== 0) continue;
      gridLayer[gr]![c] = "┄";
    }
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

  // Right-aligned label pinned to the top row (rarely used now that the
  // header carries the "last" value, but still supported).
  if (latestLabel) {
    const label = ` ${latestLabel}`;
    const trimmed = label.length > W ? label.slice(0, W) : label;
    const start = Math.max(0, W - trimmed.length);
    const row = head[0]!;
    for (let i = 0; i < trimmed.length && start + i < W; i++) row[start + i] = trimmed[i]!;
  }

  axis[0] = formatGraphNumber(plotMax);
  axis[H - 1] = formatGraphNumber(plotMin);
  if (H >= 5) {
    const midRow = Math.floor(H / 2);
    if (midRow > 0 && midRow < H - 1) {
      axis[midRow] = formatGraphNumber((plotMin + plotMax) / 2);
    }
  }

  return {
    head: head.map((r) => r.join("")),
    body: body.map((r) => r.join("")),
    grid: gridLayer.map((r) => r.join("")),
    axis,
    min: plotMin,
    max: plotMax,
  };
}

/** Backwards-compatible single-layer render: head + body + grid merged into one string per row. */
export function renderGraphLines(samples: readonly number[], width: number, height: number, latestLabel?: string): string[] {
  const layers = renderAreaGraph(samples, width, height, latestLabel);
  const out: string[] = [];
  for (let r = 0; r < layers.head.length; r++) {
    const h = layers.head[r]!;
    const b = layers.body[r]!;
    const g = layers.grid[r]!;
    let merged = "";
    for (let i = 0; i < h.length; i++) {
      const hc = h[i]!;
      if (hc !== " ") { merged += hc; continue; }
      const bc = b[i]!;
      if (bc !== " ") { merged += bc; continue; }
      merged += g[i] ?? " ";
    }
    out.push(merged);
  }
  return out;
}