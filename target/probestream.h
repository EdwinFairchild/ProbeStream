#ifndef PROBESTREAM_H
#define PROBESTREAM_H

#include "probestream_conf.h"
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Per-channel write behavior when the up-channel ring is full. */
#define PS_MODE_SKIP    0   /* Drop the entire write. */
#define PS_MODE_TRIM    1   /* Write what fits, drop the rest. */
#define PS_MODE_BLOCK   2   /* Spin until space is available. */

#if PS_ENABLED

typedef struct {
    char*             pBuffer;
    uint32_t          size;
    volatile uint32_t wrOff;
    volatile uint32_t rdOff;
    uint32_t          flags;
} PS_Channel_t;

typedef struct {
    char           magic[16];
    uint32_t       numUp;
    uint32_t       numDown;
    uint32_t       maxUp;
    uint32_t       maxDown;
    PS_Channel_t   aUp[PS_MAX_UP_CHANNELS];
    PS_Channel_t   aDown[PS_MAX_DOWN_CHANNELS];
} PS_ControlBlock_t;

typedef struct {
    void*       pBuffer;        /* RAM buffer to host the control block + ring storage. */
    uint32_t    bufferSize;     /* Size of pBuffer in bytes. */
    uint8_t     numUpChannels;  /* Number of target -> host channels to enable. */
    uint8_t     numDownChannels;/* Number of host -> target channels to enable. */
    uint8_t     defaultMode;    /* PS_MODE_SKIP / PS_MODE_TRIM / PS_MODE_BLOCK. */
} PS_Config_t;

void        PS_Init(const PS_Config_t* config);
uint32_t    PS_Write(uint8_t channel, const void* data, uint32_t numBytes);
uint32_t    PS_WriteString(uint8_t channel, const char* str);
uint32_t    PS_Read(uint8_t channel, void* data, uint32_t maxBytes);
uint32_t    PS_HasData(uint8_t channel);
void        PS_SetMode(uint8_t channel, uint8_t mode);

#if PS_ENABLE_PRINTF
#include <stdarg.h>
int         PS_Printf(uint8_t channel, const char* fmt, ...)
            __attribute__((format(printf, 2, 3)));
#endif

PS_ControlBlock_t* PS_GetControlBlock(void);

#else /* PS_ENABLED == 0 — every call compiles to nothing. */

#define PS_Init(cfg)                        ((void)0)
#define PS_Write(ch, data, len)             ((uint32_t)0)
#define PS_WriteString(ch, str)             ((uint32_t)0)
#define PS_Read(ch, data, max)              ((uint32_t)0)
#define PS_HasData(ch)                      ((uint32_t)0)
#define PS_SetMode(ch, mode)                ((void)0)
#if PS_ENABLE_PRINTF
#define PS_Printf(ch, fmt, ...)             ((int)0)
#endif
#define PS_GetControlBlock()                ((void*)0)

#endif /* PS_ENABLED */

#ifdef __cplusplus
}
#endif

#endif /* PROBESTREAM_H */
