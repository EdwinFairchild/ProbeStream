import { describe, expect, test } from "bun:test";
import {
  decodeBase64,
  encodeBase64,
  hexDump,
  toAscii,
  rawSummary,
  formatBytes,
  formatByteCount,
  formatRate,
  formatTimestamp,
  LineAssembler,
  ChunkRingBuffer,
  type StreamChunk,
} from "./index.ts";

describe("base64", () => {
  test("round-trips", () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const encoded = encodeBase64(data);
    const decoded = decodeBase64(encoded);
    expect(decoded).toEqual(data);
  });

  test("empty", () => {
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
    expect(encodeBase64(new Uint8Array(0))).toBe("");
  });
});

describe("hexDump", () => {
  test("formats 16 bytes on one line", () => {
    const data = new Uint8Array(16);
    for (let i = 0; i < 16; i++) data[i] = i;
    const dump = hexDump(data);
    expect(dump).toContain("00000000");
    expect(dump).toContain("00 01 02 03");
  });

  test("handles partial last line", () => {
    const data = new Uint8Array([0x41, 0x42, 0x43]); // ABC
    const dump = hexDump(data);
    expect(dump).toContain("41 42 43");
    expect(dump).toContain("|ABC");
  });
});

describe("toAscii", () => {
  test("printable bytes", () => {
    const data = new Uint8Array([0x48, 0x69, 0x21]); // Hi!
    expect(toAscii(data)).toBe("Hi!");
  });

  test("strips CR", () => {
    const data = new Uint8Array([0x48, 0x0d, 0x0a]); // H\r\n
    expect(toAscii(data)).toBe("H\n");
  });

  test("replaces non-printable with replacement char", () => {
    const data = new Uint8Array([0x01, 0x02, 0x7f]);
    expect(toAscii(data)).toBe("���");
  });
});

describe("rawSummary", () => {
  test("empty", () => {
    expect(rawSummary(new Uint8Array(0))).toBe("(empty)");
  });

  test("short data", () => {
    const data = new Uint8Array([0xff, 0x00]);
    expect(rawSummary(data)).toContain("ff 00");
    expect(rawSummary(data)).toContain("2 bytes");
  });
});

describe("formatBytes", () => {
  test("all modes", () => {
    const data = new Uint8Array([0x48, 0x69]);
    expect(formatBytes(data, "raw")).toContain("48 69");
    expect(formatBytes(data, "hex")).toContain("48 69");
    expect(formatBytes(data, "ascii")).toBe("Hi");
    expect(formatBytes(data, "line")).toBe("Hi");
  });
});

describe("formatByteCount", () => {
  test("bytes", () => expect(formatByteCount(42)).toBe("42 B"));
  test("KB", () => expect(formatByteCount(2048)).toBe("2.0 KB"));
  test("MB", () => expect(formatByteCount(1048576)).toBe("1.00 MB"));
});

describe("formatRate", () => {
  test("B/s", () => expect(formatRate(500)).toBe("500 B/s"));
  test("KB/s", () => expect(formatRate(2048)).toBe("2.0 KB/s"));
});

describe("LineAssembler", () => {
  test("splits complete lines", () => {
    const a = new LineAssembler();
    const lines = a.feed("hello\nworld\n");
    expect(lines).toEqual(["hello", "world"]);
  });

  test("buffers partial lines", () => {
    const a = new LineAssembler();
    expect(a.feed("hel")).toEqual([]);
    expect(a.feed("lo\n")).toEqual(["hello"]);
  });

  test("flush returns partial", () => {
    const a = new LineAssembler();
    a.feed("partial");
    expect(a.flush()).toBe("partial");
    expect(a.flush()).toBeNull();
  });

  test("handles multi-chunk stream", () => {
    const a = new LineAssembler();
    const r1 = a.feed("S:1\nS:2\nS:3");
    expect(r1).toEqual(["S:1", "S:2"]);
    const r2 = a.feed("\nS:4\n");
    expect(r2).toEqual(["S:3", "S:4"]);
  });
});

describe("ChunkRingBuffer", () => {
  function makeChunk(seq: number, bytes: number[]): StreamChunk {
    return { seq, ts: 0, channel: 0, data: new Uint8Array(bytes) };
  }

  test("basic push and retrieve", () => {
    const buf = new ChunkRingBuffer(4);
    buf.push(makeChunk(1, [1, 2]));
    buf.push(makeChunk(2, [3, 4]));
    const arr = buf.toArray();
    expect(arr.length).toBe(2);
    expect(arr[0]!.seq).toBe(1);
    expect(arr[1]!.seq).toBe(2);
  });

  test("wraps at capacity", () => {
    const buf = new ChunkRingBuffer(3);
    buf.push(makeChunk(1, [1]));
    buf.push(makeChunk(2, [2]));
    buf.push(makeChunk(3, [3]));
    buf.push(makeChunk(4, [4])); // overwrites 1
    const arr = buf.toArray();
    expect(arr.length).toBe(3);
    expect(arr[0]!.seq).toBe(2);
    expect(arr[2]!.seq).toBe(4);
  });

  test("totalBytes", () => {
    const buf = new ChunkRingBuffer(10);
    buf.push(makeChunk(1, [1, 2, 3]));
    buf.push(makeChunk(2, [4, 5]));
    expect(buf.totalBytes()).toBe(5);
  });

  test("clear", () => {
    const buf = new ChunkRingBuffer(10);
    buf.push(makeChunk(1, [1]));
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });
});
