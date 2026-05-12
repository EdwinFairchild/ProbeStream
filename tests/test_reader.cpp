#include "../host/ProbeStreamReader.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>

using namespace ProbeStream;

// Simulates target RAM in a local buffer
class FakeProbeMemory : public IProbeMemory {
public:
    FakeProbeMemory(uint8_t* base, uint32_t size, uint32_t baseAddr)
        : base_(base), size_(size), baseAddr_(baseAddr) {}

    bool readMem(uint32_t addr, uint8_t* data, uint32_t len) override {
        uint32_t off = addr - baseAddr_;
        if (off + len > size_) return false;
        std::memcpy(data, base_ + off, len);
        return true;
    }
    bool writeMem(uint32_t addr, const uint8_t* data, uint32_t len) override {
        uint32_t off = addr - baseAddr_;
        if (off + len > size_) return false;
        std::memcpy(base_ + off, data, len);
        return true;
    }

private:
    uint8_t* base_;
    uint32_t size_;
    uint32_t baseAddr_;
};

static void writeU32(uint8_t* p, uint32_t val) {
    p[0] = val & 0xFF;
    p[1] = (val >> 8) & 0xFF;
    p[2] = (val >> 16) & 0xFF;
    p[3] = (val >> 24) & 0xFF;
}

static uint32_t readU32(const uint8_t* p) {
    return p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24);
}

// Build a control block + ring buffers in a flat buffer,
// matching what the target firmware would create
struct SimulatedTarget {
    static constexpr uint32_t BASE_ADDR = 0x20000000;
    static constexpr uint32_t MAX_UP = 3;
    static constexpr uint32_t MAX_DOWN = 3;
    static constexpr uint32_t BUF_SIZE = 256;

    uint8_t ram[4096];

    uint32_t upBufAddr(int ch) {
        return BASE_ADDR + headerSize() + ch * BUF_SIZE;
    }
    uint32_t downBufAddr(int ch) {
        return BASE_ADDR + headerSize() + numUp * BUF_SIZE + ch * BUF_SIZE;
    }

    uint32_t headerSize() {
        // magic(16) + numUp(4) + numDown(4) + maxUp(4) + maxDown(4) + up_descs + down_descs
        return 32 + MAX_UP * 20 + MAX_DOWN * 20;
    }

    uint32_t numUp = 1;
    uint32_t numDown = 1;

    void build() {
        std::memset(ram, 0, sizeof(ram));
        uint8_t* p = ram;

        // Magic (written forwards for simplicity in test)
        std::memcpy(p, MAGIC, 16); p += 16;
        writeU32(p, numUp);   p += 4;
        writeU32(p, numDown); p += 4;
        writeU32(p, MAX_UP);  p += 4;
        writeU32(p, MAX_DOWN); p += 4;

        // Up channel descriptors (MAX_UP slots)
        for (uint32_t i = 0; i < MAX_UP; i++) {
            if (i < numUp) {
                writeU32(p + 0, upBufAddr(i));  // pBuffer
                writeU32(p + 4, BUF_SIZE);       // size
                writeU32(p + 8, 0);              // wrOff
                writeU32(p + 12, 0);             // rdOff
                writeU32(p + 16, 0);             // flags
            }
            p += 20;
        }

        // Down channel descriptors (MAX_DOWN slots)
        for (uint32_t i = 0; i < MAX_DOWN; i++) {
            if (i < numDown) {
                writeU32(p + 0, downBufAddr(i));
                writeU32(p + 4, BUF_SIZE);
                writeU32(p + 8, 0);
                writeU32(p + 12, 0);
                writeU32(p + 16, 0);
            }
            p += 20;
        }
    }

    // Simulate target writing to up-channel 0
    void targetWrite(const char* msg) {
        uint32_t chDescOff = 32; // first up-channel descriptor
        uint32_t wrOff = readU32(ram + chDescOff + 8);
        uint32_t bufOff = upBufAddr(0) - BASE_ADDR;
        uint32_t len = std::strlen(msg);

        for (uint32_t i = 0; i < len; i++) {
            ram[bufOff + wrOff] = msg[i];
            wrOff = (wrOff + 1) % BUF_SIZE;
        }
        writeU32(ram + chDescOff + 8, wrOff);
    }
};

void test_discover_and_read() {
    printf("test_discover_and_read... ");

    SimulatedTarget target;
    target.build();
    target.targetWrite("Hello ProbeStream!\n");

    FakeProbeMemory mem(target.ram, sizeof(target.ram), SimulatedTarget::BASE_ADDR);
    ProbeStreamReader reader(mem);

    assert(reader.discover(SimulatedTarget::BASE_ADDR, sizeof(target.ram)));
    assert(reader.isAttached());
    assert(reader.numUp() == 1);
    assert(reader.numDown() == 1);
    assert(reader.controlBlockAddr() == SimulatedTarget::BASE_ADDR);

    std::string received;
    uint32_t n = reader.pollUp([&](uint8_t ch, const uint8_t* data, uint32_t len) {
        assert(ch == 0);
        received.assign(reinterpret_cast<const char*>(data), len);
    });

    assert(n == 19);
    assert(received == "Hello ProbeStream!\n");
    printf("PASS\n");
}

void test_multiple_polls() {
    printf("test_multiple_polls... ");

    SimulatedTarget target;
    target.build();

    FakeProbeMemory mem(target.ram, sizeof(target.ram), SimulatedTarget::BASE_ADDR);
    ProbeStreamReader reader(mem);
    assert(reader.discover(SimulatedTarget::BASE_ADDR, sizeof(target.ram)));

    // First write + poll
    target.targetWrite("msg1\n");
    std::string received;
    reader.pollUp([&](uint8_t, const uint8_t* data, uint32_t len) {
        received.assign(reinterpret_cast<const char*>(data), len);
    });
    assert(received == "msg1\n");

    // Second write + poll
    target.targetWrite("msg2\n");
    received.clear();
    reader.pollUp([&](uint8_t, const uint8_t* data, uint32_t len) {
        received.assign(reinterpret_cast<const char*>(data), len);
    });
    assert(received == "msg2\n");

    printf("PASS\n");
}

void test_write_down_channel() {
    printf("test_write_down_channel... ");

    SimulatedTarget target;
    target.build();

    FakeProbeMemory mem(target.ram, sizeof(target.ram), SimulatedTarget::BASE_ADDR);
    ProbeStreamReader reader(mem);
    assert(reader.discover(SimulatedTarget::BASE_ADDR, sizeof(target.ram)));

    const char* msg = "host->target";
    uint32_t written = reader.writeDown(0,
        reinterpret_cast<const uint8_t*>(msg), std::strlen(msg));
    assert(written == std::strlen(msg));

    // Verify data appeared in the down-channel buffer on "target"
    uint32_t downDescOff = 32 + SimulatedTarget::MAX_UP * 20; // first down-channel
    uint32_t downBufAddr = target.downBufAddr(0) - SimulatedTarget::BASE_ADDR;
    uint32_t wrOff = readU32(target.ram + downDescOff + 8);
    assert(wrOff == std::strlen(msg));

    std::string got(reinterpret_cast<char*>(target.ram + downBufAddr), wrOff);
    assert(got == "host->target");

    printf("PASS\n");
}

void test_attach_known_address() {
    printf("test_attach_known_address... ");

    SimulatedTarget target;
    target.build();
    target.targetWrite("attached!\n");

    FakeProbeMemory mem(target.ram, sizeof(target.ram), SimulatedTarget::BASE_ADDR);
    ProbeStreamReader reader(mem);

    assert(reader.attach(SimulatedTarget::BASE_ADDR));
    assert(reader.numUp() == 1);

    std::string received;
    reader.pollUp([&](uint8_t, const uint8_t* data, uint32_t len) {
        received.assign(reinterpret_cast<const char*>(data), len);
    });
    assert(received == "attached!\n");

    printf("PASS\n");
}

void test_wrap_around() {
    printf("test_wrap_around... ");

    SimulatedTarget target;
    target.build();

    FakeProbeMemory mem(target.ram, sizeof(target.ram), SimulatedTarget::BASE_ADDR);
    ProbeStreamReader reader(mem);
    assert(reader.discover(SimulatedTarget::BASE_ADDR, sizeof(target.ram)));

    // Fill buffer near end, then wrap
    // Manually set wrOff near the end
    uint32_t chDescOff = 32;
    uint32_t bufOff = target.upBufAddr(0) - SimulatedTarget::BASE_ADDR;

    writeU32(target.ram + chDescOff + 8, 250);  // wrOff = 250
    writeU32(target.ram + chDescOff + 12, 250);  // rdOff = 250 (empty)

    // Host must re-read these via pollUp which reads from target
    // Write 10 bytes starting at offset 250, wrapping at 256
    const char* msg = "WRAPAROUND";
    uint32_t wrOff = 250;
    for (int i = 0; i < 10; i++) {
        target.ram[bufOff + wrOff] = msg[i];
        wrOff = (wrOff + 1) % 256;
    }
    writeU32(target.ram + chDescOff + 8, wrOff); // wrOff = (250+10)%256 = 4

    // We also need to update rdOff on target to 250 so pollUp sees data
    // Actually rdOff on target should still be 250 (we set it above)

    std::string received;
    reader.pollUp([&](uint8_t, const uint8_t* data, uint32_t len) {
        received.assign(reinterpret_cast<const char*>(data), len);
    });
    assert(received == "WRAPAROUND");

    printf("PASS\n");
}

int main() {
    printf("=== ProbeStreamReader Unit Tests ===\n");
    test_discover_and_read();
    test_multiple_polls();
    test_write_down_channel();
    test_attach_known_address();
    test_wrap_around();
    printf("=== All tests passed ===\n");
    return 0;
}
