# ProbeStream API Reference

Target-side C API. For a high-level overview and measured performance, see the top-level [README](../README.md). For the on-wire layout of the control block and ring buffers, see [wire-protocol.md](wire-protocol.md).

---

## Table of contents

- [Configuration macros](#configuration-macros)
- [Initialization](#initialization)
- [Writing to a channel](#writing-to-a-channel-target--host)
- [Reading from a channel](#reading-from-a-channel-host--target)
- [Modes](#modes)
- [Compile-out kill switch](#compile-out-kill-switch)

---

Header: `target/probestream.h`. Implementation: `target/probestream.c`.

### Configuration macros

Defined in `target/probestream_conf.h`. Override any of these by defining them in your build system or by replacing the file. All sizes are in bytes; all counts are integer limits.

| Macro | Default | Meaning |
|---|---|---|
| `PS_ENABLED` | `1` | Master switch. Set to `0` to compile every ProbeStream call to a no-op. |
| `PS_MAX_UP_CHANNELS` | `3` | Maximum number of target → host channels the control block can hold. |
| `PS_MAX_DOWN_CHANNELS` | `3` | Maximum number of host → target channels. |
| `PS_ENABLE_PRINTF` | `1` | If `0`, drops `PS_Printf` (removes the dependency on `vsnprintf`). |
| `PS_PRINTF_BUFFER_SIZE` | `128` | Stack buffer used by `PS_Printf`. Strings longer than this are truncated. |
| `PS_DEFAULT_MODE` | `0` (`PS_MODE_SKIP`) | Default mode for newly created channels. |

### Initialization

```c
typedef struct {
    void*    pBuffer;          // RAM region you provide (must outlive PS_Init)
    uint32_t bufferSize;       // size of pBuffer in bytes
    uint8_t  numUpChannels;    // 1..PS_MAX_UP_CHANNELS
    uint8_t  numDownChannels;  // 0..PS_MAX_DOWN_CHANNELS
    uint8_t  defaultMode;      // PS_MODE_SKIP | PS_MODE_TRIM | PS_MODE_BLOCK
} PS_Config_t;

void PS_Init(const PS_Config_t* config);
```

`PS_Init` lays out the control block at the start of `pBuffer`, then allocates the remainder equally between up- and down-channel ring buffers. The magic ID is written last so a partial init can never be observed by the host.

Constraints:
- `pBuffer` must be in **RAM** (the host needs to read and write its descriptors). Static `__attribute__((aligned(4)))` allocation is recommended.
- Minimum useful `bufferSize` depends on `numUpChannels + numDownChannels`. The control block header is `32 + (PS_MAX_UP_CHANNELS + PS_MAX_DOWN_CHANNELS) * 20` bytes; the rest is split evenly. Each ring needs at least 32 bytes.
- `PS_Init` should be called once, early in `main`, before any other `PS_*` call.

### Writing to a channel (target → host)

```c
uint32_t PS_Write(uint8_t channel, const void* data, uint32_t numBytes);
uint32_t PS_WriteString(uint8_t channel, const char* str);
int      PS_Printf(uint8_t channel, const char* fmt, ...);   // if PS_ENABLE_PRINTF
```

- Returns the number of bytes actually committed to the ring (may be 0 or less than requested depending on mode and free space).
- All three are interrupt-safe **on the writer side as long as only one context writes a given channel at a time**. Concurrent writers to the same channel need external locking. The host (reader) side is always safe regardless.
- `PS_Printf` uses an internal stack buffer of `PS_PRINTF_BUFFER_SIZE`. Output is truncated to fit.

### Reading from a channel (host → target)

```c
uint32_t PS_Read(uint8_t channel, void* data, uint32_t maxBytes);
uint32_t PS_HasData(uint8_t channel);
```

- `PS_Read` consumes bytes from down-channel `channel` and returns how many it copied (0..`maxBytes`). Call it from your main loop or a low-priority task there's no callback, just polling.
- `PS_HasData` returns the number of currently-buffered bytes without consuming them.

### Modes

```c
void PS_SetMode(uint8_t channel, uint8_t mode);   // up-channels only
```

Behavior when an up-channel ring is full and a write arrives:

| Mode | Constant | Behavior |
|---|---|---|
| Skip | `PS_MODE_SKIP` | Drop the entire write. Return value is 0. |
| Trim | `PS_MODE_TRIM` | Write as many bytes as fit, drop the rest. Return value is what was committed. |
| Block | `PS_MODE_BLOCK` | Busy-wait until the host advances the read pointer. Return value equals `numBytes`. |

`PS_MODE_BLOCK` is convenient for never-lose-a-byte streams but will stall your firmware indefinitely if the host stops reading. Use it only when you know the host is alive.

### Compile-out kill switch

```c
#define PS_ENABLED 0
```

Every public function becomes `((void)0)` / returns `0`. No symbols are emitted, no buffer is allocated. Useful for shipping a single binary that supports both debug and release without `#ifdef` clutter at every call site.
