import { describe, expect, test } from "bun:test";
import {
  CHANNEL_TYPE_ASCII_NUMBER,
  CHANNEL_TYPE_FLOAT32,
  CHANNEL_TYPE_INT32,
  NumericRingBuffer,
  RunningStats,
  decodeNumericSamples,
  formatNumericSamples,
  formatChannelSet,
  parseChannelSet,
  renderGraphLines,
  renderAreaGraph,
} from "./graphing.ts";

describe("graphing helpers", () => {
  test("parses and formats channel sets", () => {
    expect(parseChannelSet("2, 0 2 bad -1 1")).toEqual([0, 1, 2]);
    expect(formatChannelSet([3, 1, 3, 0])).toBe("0,1,3");
  });

  test("decodes strict ASCII numbers only", () => {
    const ok = decodeNumericSamples(CHANNEL_TYPE_ASCII_NUMBER, new TextEncoder().encode("12 -0.5\n1e2"));
    expect(ok.samples).toEqual([12, -0.5, 100]);

    const bad = decodeNumericSamples(CHANNEL_TYPE_ASCII_NUMBER, new TextEncoder().encode("temp=12"));
    expect(bad.samples).toEqual([]);
    expect(bad.error).toContain("strict numeric");
  });

  test("decodes binary numeric samples", () => {
    const intBytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x2a, 0, 0, 0]);
    expect(decodeNumericSamples(CHANNEL_TYPE_INT32, intBytes).samples).toEqual([-1, 42]);

    const floatBytes = new Uint8Array(4);
    new DataView(floatBytes.buffer).setFloat32(0, 12.5, true);
    expect(decodeNumericSamples(CHANNEL_TYPE_FLOAT32, floatBytes).samples[0]).toBe(12.5);
    expect(formatNumericSamples(CHANNEL_TYPE_FLOAT32, floatBytes)).toBe("12.5");
  });

  test("ring buffer keeps the latest values", () => {
    const ring = new NumericRingBuffer(3);
    ring.pushAll([1, 2, 3, 4]);
    expect(ring.toArray()).toEqual([2, 3, 4]);
    expect(ring.latest).toBe(4);
  });

  test("running stats use all values seen since enabled", () => {
    const stats = new RunningStats();
    stats.pushAll([1, 2, 3, 4]);
    expect(stats.count).toBe(4);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
    expect(stats.mean).toBe(2.5);
    expect(stats.stddev).toBeCloseTo(1.29099, 4);
  });

  test("renders graph lines with a latest label", () => {
    const lines = renderGraphLines([1, 2, 3, 4], 20, 4, "last 4");
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("last 4");
    // Dot style uses braille glyphs (U+2800..U+28FF).
    expect(/[\u2800-\u28FF]/.test(lines.join("\n"))).toBe(true);
  });

  test("renderAreaGraph splits head and body, exposes axis ticks", () => {
    const samples = Array.from({ length: 40 }, (_, i) => Math.sin(i / 4) * 5 + 10);
    const layers = renderAreaGraph(samples, 30, 5, "last 9.99");
    expect(layers.head).toHaveLength(5);
    expect(layers.body).toHaveLength(5);
    expect(layers.grid).toHaveLength(5);
    // Head should contain braille dot glyphs from the curve.
    expect(/[\u2800-\u28FF]/.test(layers.head.join("\n"))).toBe(true);
    // Body layer is reserved for area-fill renderers; the dot renderer
    // leaves it blank so the curve reads as a clean trace.
    expect(layers.body.every((row) => /^\s*$/.test(row))).toBe(true);
    // Min, mid, and max axis labels populated; the rows just inside the
    // extremes stay blank.
    expect(layers.axis[0]).not.toBe("");
    expect(layers.axis[layers.axis.length - 1]).not.toBe("");
    expect(layers.axis[1]).toBe("");
    expect(layers.axis[Math.floor(5 / 2)]).not.toBe("");
    // Latest label survived the head pass.
    expect(layers.head.join("\n")).toContain("last 9.99");
  });
});