# ProbeStream Wire Protocol

This document describes the in-RAM layout of the ProbeStream control block and ring buffers. You don't need this to use the library — it's here if you're writing your own host reader, porting to a language with no existing host library, or just want to understand what's in memory.

All multi-byte fields are little-endian, which on every supported Cortex-M target also matches native byte order, so byte-level reads work directly.

---

## Table of contents

- [Control block header](#control-block-header)
- [Channel descriptor](#channel-descriptor)
- [Descriptor layout](#descriptor-layout)
- [Ring buffer semantics](#ring-buffer-semantics)
- [Discovery](#discovery)
- [Performance notes](#performance-notes)

---

## Control block header (32 bytes, at the start of the user-provided RAM buffer)

| Offset | Size | Name | Meaning |
|---|---|---|---|
| 0  | 16 | `magic`   | `"ProbeStreamV1\0\0\0"`. Written backwards at init. |
| 16 | 4  | `numUp`   | Number of active up-channels (`1..maxUp`). |
| 20 | 4  | `numDown` | Number of active down-channels (`0..maxDown`). |
| 24 | 4  | `maxUp`   | Compile-time `PS_MAX_UP_CHANNELS`. |
| 28 | 4  | `maxDown` | Compile-time `PS_MAX_DOWN_CHANNELS`. |

`maxUp`/`maxDown` are exposed so the host can compute the offset of the down-channel descriptors without knowing target compile-time constants.

## Channel descriptor (20 bytes per channel)

| Offset | Size | Name | Meaning |
|---|---|---|---|
| 0  | 4 | `pBuffer` | Absolute target address of this channel's ring storage. |
| 4  | 4 | `size`    | Size of the ring in bytes. |
| 8  | 4 | `wrOff`   | Write offset into the ring (writer-only). |
| 12 | 4 | `rdOff`   | Read offset into the ring (reader-only). |
| 16 | 4 | `flags`   | Per-channel flags. Bit field; currently only the mode (`PS_MODE_*`) lives in the low byte. |

## Descriptor layout

Immediately after the header come `maxUp` up-channel descriptors, then `maxDown` down-channel descriptors. Slot `[i]` is active if `i < numUp`, otherwise zeroed. Use `maxUp` from the header to find where down channels start:

```
HEADER_SIZE = 32
upChannel[i].descAddr   = cbAddr + 32 + i * 20
downChannel[i].descAddr = cbAddr + 32 + maxUp * 20 + i * 20
```

## Ring buffer semantics

Standard SPSC ring with `size - 1` usable bytes:

- `wrOff == rdOff` means **empty**.
- `wrOff + 1 == rdOff` (mod `size`) means **full**.
- The **writer** advances `wrOff` after copying bytes into `pBuffer[wrOff]`.
- The **reader** advances `rdOff` after reading bytes from `pBuffer[rdOff]`.

For up-channels the target is the writer and the host is the reader. For down-channels it's reversed.

The target issues a Cortex-M `DMB` (data memory barrier) before publishing a new offset, so the data is always visible before the offset bump. A host reading over SWD gets a consistent view as long as it reads the data before the offset.

## Discovery

To find the control block at runtime, scan the target's RAM for the 16-byte magic at any 4-byte alignment. The magic is unique enough that no false positives have been observed even scanning the entire RAM range.

---

## Performance notes

One poll of an up-channel costs:

```
2 reads of 4 bytes  (wrOff, rdOff)
+ 1 bulk read of N bytes  (ring contents, may wrap and require two reads)
+ 1 write of 4 bytes  (advance rdOff)
```

The dominant cost is the bulk read. If the host can issue that as a single SWD memory read transaction it gets the full SWD wire bandwidth. If the backend reads one 32-bit word per USB round-trip instead, each round-trip costs ~100–500 µs regardless of how few bytes you actually needed — that's the difference between ~100 KB/s and ~25 KB/s seen on the reference boards (see [README](../README.md)).

Things that don't matter:
- MCU clock speed — the target fills its ring buffer many times faster than the host can drain it.
- `PS_Printf` vs `PS_Write` — target-side cost is negligible.

Things that matter:
- SWD clock (capped by the probe driver, often 500 kHz – 24 MHz).
- Whether the host backend can issue bulk memory reads or is limited to per-word accesses.
- Buffer size — bigger buffers absorb bursts when the host falls behind.
- Per-USB-transaction overhead (probe and OS specific).
