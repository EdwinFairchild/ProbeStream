#ifndef PROBESTREAM_PROTOCOL_H
#define PROBESTREAM_PROTOCOL_H

#include <cstdint>
#include <cstring>

namespace ProbeStream {

static constexpr char MAGIC[16] = {'P','r','o','b','e','S','t','r','e','a','m','V','1','\0','\0','\0'};
static constexpr uint32_t MAGIC_LEN = 16;

// Control block header offsets (all uint32_t except magic)
static constexpr uint32_t OFF_MAGIC    = 0;
static constexpr uint32_t OFF_NUM_UP   = 16;
static constexpr uint32_t OFF_NUM_DOWN = 20;
static constexpr uint32_t OFF_MAX_UP   = 24;
static constexpr uint32_t OFF_MAX_DOWN = 28;
static constexpr uint32_t HEADER_SIZE  = 32;

// Channel descriptor: 20 bytes on 32-bit targets
static constexpr uint32_t CH_OFF_PBUFFER = 0;
static constexpr uint32_t CH_OFF_SIZE    = 4;
static constexpr uint32_t CH_OFF_WROFF   = 8;
static constexpr uint32_t CH_OFF_RDOFF   = 12;
static constexpr uint32_t CH_OFF_FLAGS   = 16;
static constexpr uint32_t CH_DESC_SIZE   = 20;

inline uint32_t upChannelOffset(uint32_t index) {
    return HEADER_SIZE + index * CH_DESC_SIZE;
}

inline uint32_t downChannelOffset(uint32_t maxUp, uint32_t index) {
    return HEADER_SIZE + maxUp * CH_DESC_SIZE + index * CH_DESC_SIZE;
}

} // namespace ProbeStream

#endif // PROBESTREAM_PROTOCOL_H
