#include "ProbeStreamReader.h"
#include <algorithm>
#include <cstring>

namespace ProbeStream {

ProbeStreamReader::ProbeStreamReader(IProbeMemory& mem)
    : mem_(mem)
{
}

bool ProbeStreamReader::discover(uint32_t ramStart, uint32_t ramSize, uint32_t scanChunkSize)
{
    std::vector<uint8_t> buf(scanChunkSize + MAGIC_LEN);

    for (uint32_t offset = 0; offset < ramSize; offset += scanChunkSize) {
        uint32_t addr = ramStart + offset;
        uint32_t readLen = std::min(scanChunkSize, ramSize - offset);

        if (!mem_.readMem(addr, buf.data(), readLen))
            continue;

        for (uint32_t i = 0; i + MAGIC_LEN <= readLen; i++) {
            if (std::memcmp(buf.data() + i, MAGIC, MAGIC_LEN) == 0) {
                cbAddr_ = addr + i;
                return readControlBlock();
            }
        }
    }
    return false;
}

bool ProbeStreamReader::attach(uint32_t cbAddr)
{
    uint8_t magic[MAGIC_LEN];
    if (!mem_.readMem(cbAddr, magic, MAGIC_LEN))
        return false;
    if (std::memcmp(magic, MAGIC, MAGIC_LEN) != 0)
        return false;

    cbAddr_ = cbAddr;
    return readControlBlock();
}

bool ProbeStreamReader::readControlBlock()
{
    numUp_   = readU32(cbAddr_ + OFF_NUM_UP);
    numDown_ = readU32(cbAddr_ + OFF_NUM_DOWN);
    maxUp_   = readU32(cbAddr_ + OFF_MAX_UP);
    maxDown_ = readU32(cbAddr_ + OFF_MAX_DOWN);

    if (numUp_ == 0 || numUp_ > 64 || numDown_ > 64)
        return false;
    if (maxUp_ < numUp_ || maxDown_ < numDown_)
        return false;

    upChannels_.resize(numUp_);
    for (uint32_t i = 0; i < numUp_; i++) {
        auto& ch = upChannels_[i];
        ch.descAddr = cbAddr_ + upChannelOffset(i);
        ch.pBuffer = readU32(ch.descAddr + CH_OFF_PBUFFER);
        ch.size    = readU32(ch.descAddr + CH_OFF_SIZE);
        ch.wrOff   = 0;
        ch.rdOff   = 0;
        ch.flags   = readU32(ch.descAddr + CH_OFF_FLAGS);
    }

    downChannels_.resize(numDown_);
    for (uint32_t i = 0; i < numDown_; i++) {
        auto& ch = downChannels_[i];
        ch.descAddr = cbAddr_ + downChannelOffset(maxUp_, i);
        ch.pBuffer = readU32(ch.descAddr + CH_OFF_PBUFFER);
        ch.size    = readU32(ch.descAddr + CH_OFF_SIZE);
        ch.wrOff   = 0;
        ch.rdOff   = 0;
        ch.flags   = readU32(ch.descAddr + CH_OFF_FLAGS);
    }

    return true;
}

bool ProbeStreamReader::refreshChannel(ChannelState& ch)
{
    ch.wrOff = readU32(ch.descAddr + CH_OFF_WROFF);
    ch.rdOff = readU32(ch.descAddr + CH_OFF_RDOFF);
    ch.flags = readU32(ch.descAddr + CH_OFF_FLAGS);
    return true;
}

uint32_t ProbeStreamReader::pollUp(const DataCallback& cb)
{
    uint32_t totalRead = 0;

    for (uint8_t i = 0; i < numUp_; i++) {
        auto& ch = upChannels_[i];
        uint32_t wrOff = readU32(ch.descAddr + CH_OFF_WROFF);
        uint32_t rdOff = readU32(ch.descAddr + CH_OFF_RDOFF);
        ch.flags = readU32(ch.descAddr + CH_OFF_FLAGS);

        if (wrOff == rdOff)
            continue;

        uint32_t avail;
        if (wrOff >= rdOff)
            avail = wrOff - rdOff;
        else
            avail = ch.size - (rdOff - wrOff);

        if (avail == 0 || avail >= ch.size)
            continue;

        std::vector<uint8_t> data(avail);
        uint32_t read = 0;

        if (wrOff > rdOff) {
            mem_.readMem(ch.pBuffer + rdOff, data.data(), avail);
            read = avail;
        } else {
            uint32_t part1 = ch.size - rdOff;
            mem_.readMem(ch.pBuffer + rdOff, data.data(), part1);
            if (wrOff > 0)
                mem_.readMem(ch.pBuffer, data.data() + part1, wrOff);
            read = part1 + wrOff;
        }

        // Advance rdOff on target
        writeU32(ch.descAddr + CH_OFF_RDOFF, wrOff);
        ch.rdOff = wrOff;
        ch.wrOff = wrOff;

        if (read > 0 && cb)
            cb(i, data.data(), read);

        totalRead += read;
    }

    return totalRead;
}

uint32_t ProbeStreamReader::writeDown(uint8_t channel, const uint8_t* data, uint32_t len)
{
    if (channel >= numDown_ || len == 0)
        return 0;

    auto& ch = downChannels_[channel];
    uint32_t wrOff = readU32(ch.descAddr + CH_OFF_WROFF);
    uint32_t rdOff = readU32(ch.descAddr + CH_OFF_RDOFF);

    // Calculate free space
    uint32_t free;
    if (rdOff > wrOff)
        free = rdOff - wrOff - 1;
    else
        free = (ch.size - 1) - (wrOff - rdOff);

    if (free == 0)
        return 0;

    uint32_t toWrite = std::min(len, free);
    uint32_t written = 0;

    if (wrOff + toWrite <= ch.size) {
        // Contiguous write, but check wrap boundary
        uint32_t firstPart = std::min(toWrite, ch.size - wrOff);
        mem_.writeMem(ch.pBuffer + wrOff, data, firstPart);
        written = firstPart;
        uint32_t newWr = wrOff + firstPart;
        if (newWr >= ch.size)
            newWr = 0;

        if (written < toWrite) {
            uint32_t secondPart = toWrite - written;
            mem_.writeMem(ch.pBuffer, data + written, secondPart);
            written += secondPart;
            newWr = secondPart;
        }
        writeU32(ch.descAddr + CH_OFF_WROFF, newWr);
        ch.wrOff = newWr;
    } else {
        uint32_t part1 = ch.size - wrOff;
        mem_.writeMem(ch.pBuffer + wrOff, data, part1);
        uint32_t part2 = toWrite - part1;
        if (part2 > 0)
            mem_.writeMem(ch.pBuffer, data + part1, part2);
        written = toWrite;
        uint32_t newWr = part2;
        writeU32(ch.descAddr + CH_OFF_WROFF, newWr);
        ch.wrOff = newWr;
    }

    return written;
}

uint32_t ProbeStreamReader::readU32(uint32_t addr)
{
    uint8_t buf[4];
    mem_.readMem(addr, buf, 4);
    return buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
}

void ProbeStreamReader::writeU32(uint32_t addr, uint32_t val)
{
    uint8_t buf[4] = {
        static_cast<uint8_t>(val & 0xFF),
        static_cast<uint8_t>((val >> 8) & 0xFF),
        static_cast<uint8_t>((val >> 16) & 0xFF),
        static_cast<uint8_t>((val >> 24) & 0xFF),
    };
    mem_.writeMem(addr, buf, 4);
}

} // namespace ProbeStream
