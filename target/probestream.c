#include "probestream.h"

#if PS_ENABLED

#include <string.h>

#if PS_ENABLE_PRINTF
#include <stdio.h>
#endif

/* Written backwards during init to prevent a partial copy from matching a scan. */
static const char ps_magic[16] = "ProbeStreamV1\0\0\0";

static PS_ControlBlock_t* s_cb;

#if defined(__ARM_ARCH)
  #define PS_DMB()  __asm volatile ("dmb" ::: "memory")
#else
  #define PS_DMB()  __asm volatile ("" ::: "memory")
#endif

static inline uint32_t rb_free(const PS_Channel_t* ch)
{
    uint32_t wr = ch->wrOff;
    uint32_t rd = ch->rdOff;
    if (rd > wr)
        return rd - wr - 1u;
    return (ch->size - 1u) - (wr - rd);
}

static inline uint32_t rb_used(const PS_Channel_t* ch)
{
    uint32_t wr = ch->wrOff;
    uint32_t rd = ch->rdOff;
    if (wr >= rd)
        return wr - rd;
    return ch->size - (rd - wr);
}

static uint32_t rb_write(PS_Channel_t* ch, const uint8_t* data, uint32_t len)
{
    uint32_t wr = ch->wrOff;
    uint32_t size = ch->size;
    char* buf = ch->pBuffer;
    uint32_t written = 0;

    while (written < len) {
        uint32_t chunk;
        if (wr >= ch->rdOff)
            chunk = size - wr - (ch->rdOff == 0 ? 1 : 0);
        else
            chunk = ch->rdOff - wr - 1;

        if (chunk == 0)
            break;

        uint32_t remaining = len - written;
        if (chunk > remaining)
            chunk = remaining;

        memcpy(buf + wr, data + written, chunk);
        written += chunk;
        wr += chunk;
        if (wr >= size)
            wr = 0;
    }

    PS_DMB();
    ch->wrOff = wr;
    return written;
}

static uint32_t rb_read(PS_Channel_t* ch, uint8_t* data, uint32_t maxLen)
{
    uint32_t rd = ch->rdOff;
    uint32_t wr = ch->wrOff;
    uint32_t size = ch->size;
    char* buf = ch->pBuffer;
    uint32_t total = 0;

    while (total < maxLen) {
        uint32_t chunk;
        if (wr >= rd)
            chunk = wr - rd;
        else
            chunk = size - rd;

        if (chunk == 0)
            break;

        uint32_t remaining = maxLen - total;
        if (chunk > remaining)
            chunk = remaining;

        memcpy(data + total, buf + rd, chunk);
        total += chunk;
        rd += chunk;
        if (rd >= size)
            rd = 0;
    }

    PS_DMB();
    ch->rdOff = rd;
    return total;
}

static inline uint32_t ps_type_flags(uint8_t type)
{
    return ((uint32_t)(type & PS_CHANNEL_TYPE_MASK)) << PS_CHANNEL_TYPE_SHIFT;
}

static inline void ps_mark_type(PS_Channel_t* ch, uint8_t type)
{
    uint32_t mode = ch->flags & PS_MODE_MASK;
    ch->flags = mode | ps_type_flags(type);
}

static uint32_t ps_write_typed(uint8_t channel, const void* data, uint32_t numBytes, uint8_t type)
{
    if (!s_cb || channel >= s_cb->numUp || numBytes == 0)
        return 0;

    ps_mark_type(&s_cb->aUp[channel], type);
    return PS_Write(channel, data, numBytes);
}

void PS_Init(const PS_Config_t* config)
{
    if (!config || !config->pBuffer || config->numUpChannels == 0)
        return;
    if (config->numUpChannels > PS_MAX_UP_CHANNELS)
        return;
    if (config->numDownChannels > PS_MAX_DOWN_CHANNELS)
        return;

    uint8_t* mem = (uint8_t*)config->pBuffer;
    uint32_t totalSize = config->bufferSize;

    s_cb = (PS_ControlBlock_t*)mem;
    memset(s_cb, 0, sizeof(PS_ControlBlock_t));

    s_cb->numUp   = config->numUpChannels;
    s_cb->numDown  = config->numDownChannels;
    s_cb->maxUp   = PS_MAX_UP_CHANNELS;
    s_cb->maxDown  = PS_MAX_DOWN_CHANNELS;

    uint32_t headerSize = sizeof(PS_ControlBlock_t);
    if (headerSize >= totalSize)
        return;

    uint32_t dataArea = totalSize - headerSize;
    uint32_t totalChannels = config->numUpChannels + config->numDownChannels;
    uint32_t perChannel = dataArea / totalChannels;

    if (perChannel < 32)
        return;

    uint8_t* dataPtr = mem + headerSize;

    for (uint8_t i = 0; i < config->numUpChannels; i++) {
        s_cb->aUp[i].pBuffer = (char*)dataPtr;
        s_cb->aUp[i].size    = perChannel;
        s_cb->aUp[i].wrOff   = 0;
        s_cb->aUp[i].rdOff   = 0;
        s_cb->aUp[i].flags   = config->defaultMode & PS_MODE_MASK;
        dataPtr += perChannel;
    }

    for (uint8_t i = 0; i < config->numDownChannels; i++) {
        s_cb->aDown[i].pBuffer = (char*)dataPtr;
        s_cb->aDown[i].size    = perChannel;
        s_cb->aDown[i].wrOff   = 0;
        s_cb->aDown[i].rdOff   = 0;
        s_cb->aDown[i].flags   = config->defaultMode & PS_MODE_MASK;
        dataPtr += perChannel;
    }

    PS_DMB();
    for (int i = 15; i >= 0; i--)
        s_cb->magic[i] = ps_magic[i];
    PS_DMB();
}

uint32_t PS_Write(uint8_t channel, const void* data, uint32_t numBytes)
{
    if (!s_cb || channel >= s_cb->numUp || numBytes == 0)
        return 0;

    PS_Channel_t* ch = &s_cb->aUp[channel];
    uint32_t mode = ch->flags & PS_MODE_MASK;

    if (mode == PS_MODE_BLOCK) {
        uint32_t written = 0;
        while (written < numBytes) {
            uint32_t n = rb_write(ch, (const uint8_t*)data + written,
                                  numBytes - written);
            written += n;
        }
        return written;
    }

    uint32_t avail = rb_free(ch);
    if (mode == PS_MODE_SKIP) {
        if (avail < numBytes)
            return 0;
    } else {
        if (numBytes > avail)
            numBytes = avail;
    }

    return rb_write(ch, (const uint8_t*)data, numBytes);
}

uint32_t PS_WriteString(uint8_t channel, const char* str)
{
    if (!str) return 0;
    uint32_t len = 0;
    while (str[len]) len++;
    return PS_Write(channel, str, len);
}

uint32_t PS_WriteInt(uint8_t channel, int32_t value)
{
    uint8_t bytes[4] = {
        (uint8_t)((uint32_t)value & 0xffu),
        (uint8_t)(((uint32_t)value >> 8) & 0xffu),
        (uint8_t)(((uint32_t)value >> 16) & 0xffu),
        (uint8_t)(((uint32_t)value >> 24) & 0xffu),
    };
    return ps_write_typed(channel, bytes, sizeof(bytes), PS_CHANNEL_TYPE_INT32);
}

uint32_t PS_WriteUInt(uint8_t channel, uint32_t value)
{
    uint8_t bytes[4] = {
        (uint8_t)(value & 0xffu),
        (uint8_t)((value >> 8) & 0xffu),
        (uint8_t)((value >> 16) & 0xffu),
        (uint8_t)((value >> 24) & 0xffu),
    };
    return ps_write_typed(channel, bytes, sizeof(bytes), PS_CHANNEL_TYPE_UINT32);
}

uint32_t PS_WriteFloat(uint8_t channel, float value)
{
    uint8_t bytes[sizeof(float)];
    memcpy(bytes, &value, sizeof(bytes));
    return ps_write_typed(channel, bytes, sizeof(bytes), PS_CHANNEL_TYPE_FLOAT32);
}

uint32_t PS_WriteDouble(uint8_t channel, double value)
{
    uint8_t bytes[sizeof(double)];
    memcpy(bytes, &value, sizeof(bytes));
    return ps_write_typed(channel, bytes, sizeof(bytes), PS_CHANNEL_TYPE_FLOAT64);
}

uint32_t PS_Read(uint8_t channel, void* data, uint32_t maxBytes)
{
    if (!s_cb || channel >= s_cb->numDown || maxBytes == 0)
        return 0;
    return rb_read(&s_cb->aDown[channel], (uint8_t*)data, maxBytes);
}

uint32_t PS_HasData(uint8_t channel)
{
    if (!s_cb || channel >= s_cb->numDown)
        return 0;
    return rb_used(&s_cb->aDown[channel]);
}

void PS_SetMode(uint8_t channel, uint8_t mode)
{
    if (!s_cb || channel >= s_cb->numUp)
        return;
    s_cb->aUp[channel].flags = (s_cb->aUp[channel].flags & ~PS_MODE_MASK) | (mode & PS_MODE_MASK);
}

void PS_SetChannelType(uint8_t channel, uint8_t type)
{
    if (!s_cb || channel >= s_cb->numUp)
        return;
    ps_mark_type(&s_cb->aUp[channel], type);
}

PS_ControlBlock_t* PS_GetControlBlock(void)
{
    return s_cb;
}

#if PS_ENABLE_PRINTF
int PS_Printf(uint8_t channel, const char* fmt, ...)
{
    char buf[PS_PRINTF_BUFFER_SIZE];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n > 0) {
        uint32_t len = (uint32_t)n;
        if (len > sizeof(buf) - 1)
            len = sizeof(buf) - 1;
        PS_Write(channel, buf, len);
    }
    return n;
}
#endif

#endif /* PS_ENABLED */
