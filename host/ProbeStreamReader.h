#ifndef PROBESTREAM_READER_H
#define PROBESTREAM_READER_H

#include "ProbeStreamProtocol.h"
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ProbeStream {

class IProbeMemory {
public:
    virtual ~IProbeMemory() = default;
    virtual bool readMem(uint32_t addr, uint8_t* data, uint32_t len) = 0;
    virtual bool writeMem(uint32_t addr, const uint8_t* data, uint32_t len) = 0;
};

struct ChannelState {
    uint32_t pBuffer = 0;
    uint32_t size    = 0;
    uint32_t wrOff   = 0;
    uint32_t rdOff   = 0;
    uint32_t flags   = 0;
    uint32_t descAddr = 0;  // address of channel descriptor on target
};

using DataCallback = std::function<void(uint8_t channel, const uint8_t* data, uint32_t len)>;

class ProbeStreamReader {
public:
    explicit ProbeStreamReader(IProbeMemory& mem);

    // Scan target RAM for the magic ID. Returns true if found.
    bool discover(uint32_t ramStart, uint32_t ramSize, uint32_t scanChunkSize = 1024);

    // Use a known control block address instead of scanning.
    bool attach(uint32_t cbAddr);

    // Poll up-channels: reads new data since last poll, calls callback.
    // Returns total bytes read across all up-channels.
    uint32_t pollUp(const DataCallback& cb);

    // Write data to a down-channel.
    uint32_t writeDown(uint8_t channel, const uint8_t* data, uint32_t len);

    bool isAttached() const { return cbAddr_ != 0; }
    uint32_t controlBlockAddr() const { return cbAddr_; }
    uint32_t numUp() const { return numUp_; }
    uint32_t numDown() const { return numDown_; }

    const ChannelState& upChannel(uint8_t ch) const { return upChannels_[ch]; }
    const ChannelState& downChannel(uint8_t ch) const { return downChannels_[ch]; }

private:
    bool readControlBlock();
    bool refreshChannel(ChannelState& ch);
    uint32_t readU32(uint32_t addr);
    void writeU32(uint32_t addr, uint32_t val);

    IProbeMemory& mem_;
    uint32_t cbAddr_ = 0;
    uint32_t numUp_ = 0;
    uint32_t numDown_ = 0;
    uint32_t maxUp_ = 0;
    uint32_t maxDown_ = 0;
    std::vector<ChannelState> upChannels_;
    std::vector<ChannelState> downChannels_;
};

} // namespace ProbeStream

#endif // PROBESTREAM_READER_H
