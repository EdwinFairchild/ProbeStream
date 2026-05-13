#include "main.h"
#include "gpio.h"
#include "probestream.h"
#include <string.h>

void SystemClock_Config(void);

/*
 * Stress test firmware for ProbeStream throughput measurement.
 *
 * Test modes (sent via down-channel as "mode N\n"):
 *   0 = idle (stop writing)
 *   1 = continuous counter: "SEQ:NNNNNNN\n" as fast as possible
 *   2 = bulk fill: write 'A' bytes filling entire buffer each iteration
 *   3 = small packets: write "P:NNNN\n" (~8 bytes) as fast as possible
 *   4 = echo: read down-channel, write back on up-channel (latency test)
 *   6 = multi-channel: ch0 command/log traffic, ch1 telemetry traffic
 *   7 = graph demo: ch0 logs, ch1 float32 waveform, ch2 int32 ramp
 *
 * Buffer size controlled by compile-time PS_STRESS_BUFSZ (default 16384).
 * Down-channel commands:
 *   "mode N\n"    — switch test mode
 *   "bufsz N\n"   — reinit with N-byte buffer (up to 16384)
 *   "reset\n"     — reset counters
 *   anything else — echoed back to the matching up-channel in modes 4 and 6
 */

#ifndef PS_STRESS_BUFSZ
#define PS_STRESS_BUFSZ 16384
#endif

#define PS_STRESS_UP_CHANNELS   3
#define PS_STRESS_DOWN_CHANNELS 2

static uint8_t ps_buffer[PS_STRESS_BUFSZ] __attribute__((aligned(4)));

static volatile uint32_t test_mode = 0;
static uint32_t seq_counter = 0;
static uint32_t bytes_written = 0;
static uint32_t drops = 0;

static void init_probestream(uint32_t bufsz)
{
    PS_Config_t ps_cfg = {
        .pBuffer        = ps_buffer,
        .bufferSize     = bufsz,
        .numUpChannels  = PS_STRESS_UP_CHANNELS,
        .numDownChannels = PS_STRESS_DOWN_CHANNELS,
        .defaultMode    = PS_MODE_TRIM,
    };
    PS_Init(&ps_cfg);
    PS_SetChannelType(0, PS_CHANNEL_TYPE_TEXT);
    PS_SetChannelType(1, PS_CHANNEL_TYPE_FLOAT32);
    PS_SetChannelType(2, PS_CHANNEL_TYPE_INT32);
    seq_counter = 0;
    bytes_written = 0;
    drops = 0;
}

static void process_command(uint8_t channel, char *cmd)
{
    uint8_t reply_channel = channel < PS_STRESS_UP_CHANNELS ? channel : 0;

    if (strncmp(cmd, "mode ", 5) == 0) {
        uint32_t m = cmd[5] - '0';
        if (m <= 7) {
            test_mode = m;
            seq_counter = 0;
            bytes_written = 0;
            drops = 0;
            PS_Printf(reply_channel, "[mode=%lu]\n", m);
        }
    } else if (strncmp(cmd, "bufsz ", 6) == 0) {
        uint32_t val = 0;
        for (int i = 6; cmd[i] >= '0' && cmd[i] <= '9'; i++)
            val = val * 10 + (cmd[i] - '0');
        if (val >= 256 && val <= PS_STRESS_BUFSZ) {
            test_mode = 0;
            init_probestream(val);
            PS_Printf(reply_channel, "[bufsz=%lu]\n", val);
        }
    } else if (strcmp(cmd, "reset") == 0) {
        seq_counter = 0;
        bytes_written = 0;
        drops = 0;
        PS_Printf(reply_channel, "[reset]\n");
    } else if (strcmp(cmd, "stats") == 0) {
        PS_Printf(reply_channel, "[stats seq=%lu bytes=%lu drops=%lu]\n",
                  seq_counter, bytes_written, drops);
    } else if (test_mode == 4 || test_mode == 6) {
        PS_Printf(reply_channel, "[down ch%u] ", channel);
        PS_Write(reply_channel, (const uint8_t *)cmd, strlen(cmd));
        PS_Write(reply_channel, (const uint8_t *)"\n", 1);
    }
}

static void check_commands(void)
{
    static char cmd_buf[PS_STRESS_DOWN_CHANNELS][64];
    static uint32_t cmd_pos[PS_STRESS_DOWN_CHANNELS];

    uint8_t rx[64];
    for (uint8_t channel = 0; channel < PS_STRESS_DOWN_CHANNELS; channel++) {
        uint32_t n = PS_Read(channel, rx, sizeof(rx));
        for (uint32_t i = 0; i < n; i++) {
            if (rx[i] == '\n' || rx[i] == '\r') {
                if (cmd_pos[channel] > 0) {
                    cmd_buf[channel][cmd_pos[channel]] = '\0';
                    process_command(channel, cmd_buf[channel]);
                    cmd_pos[channel] = 0;
                }
            } else if (cmd_pos[channel] < sizeof(cmd_buf[channel]) - 1) {
                cmd_buf[channel][cmd_pos[channel]++] = rx[i];
            }
        }
    }
}

int main(void)
{
    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    BSP_LED_Init(LED_GREEN);

    init_probestream(PS_STRESS_BUFSZ);

    PS_Printf(0, "[stress_test ready bufsz=%u]\n", PS_STRESS_BUFSZ);
    test_mode = 0;

    uint32_t led_tick = 0;

    while (1) {
        check_commands();

        switch (test_mode) {
        case 1: {
            char buf[32];
            int len = 0;
            // Manual integer-to-string to avoid printf overhead
            uint32_t v = seq_counter;
            char digits[10];
            int nd = 0;
            do { digits[nd++] = '0' + (v % 10); v /= 10; } while (v);
            buf[len++] = 'S';
            buf[len++] = ':';
            for (int i = nd - 1; i >= 0; i--) buf[len++] = digits[i];
            buf[len++] = '\n';
            uint32_t w = PS_Write(0, buf, len);
            if (w == (uint32_t)len) {
                bytes_written += w;
                seq_counter++;
            } else {
                drops++;
            }
            break;
        }
        case 2: {
            // Bulk: fill with pattern bytes
            static uint8_t fill_buf[256];
            static int fill_init = 0;
            if (!fill_init) {
                for (int i = 0; i < 256; i++) fill_buf[i] = 'A' + (i % 26);
                fill_init = 1;
            }
            uint32_t w = PS_Write(0, fill_buf, sizeof(fill_buf));
            bytes_written += w;
            if (w < sizeof(fill_buf)) drops++;
            seq_counter++;
            break;
        }
        case 3: {
            char buf[8];
            buf[0] = 'P';
            buf[1] = ':';
            buf[2] = '0' + ((seq_counter / 1000) % 10);
            buf[3] = '0' + ((seq_counter / 100) % 10);
            buf[4] = '0' + ((seq_counter / 10) % 10);
            buf[5] = '0' + (seq_counter % 10);
            buf[6] = '\n';
            uint32_t w = PS_Write(0, buf, 7);
            if (w == 7) {
                bytes_written += 7;
                seq_counter++;
            } else {
                drops++;
            }
            break;
        }
        case 4:
            // Echo mode — handled in check_commands
            break;
        case 6: {
            static uint32_t last_tick = 0;
            uint32_t now = HAL_GetTick();
            if ((now - last_tick) >= 10) {
                last_tick = now;
                int n0 = PS_Printf(0, "[m6 ch0] seq=%lu tick=%lu command-plane\n", seq_counter, now);
                int n1 = PS_Printf(1, "[m6 ch1] seq=%lu tick=%lu telemetry=%lu\n",
                                   seq_counter, now, (seq_counter * 37) % 1000);
                if (n0 > 0) bytes_written += (uint32_t)n0; else drops++;
                if (n1 > 0) bytes_written += (uint32_t)n1; else drops++;
                seq_counter++;
            }
            break;
        }
        case 7: {
            static uint32_t last_tick = 0;
            uint32_t now = HAL_GetTick();
            if ((now - last_tick) >= 25) {
                last_tick = now;
                int n0 = PS_Printf(0, "[m7 graph] seq=%lu tick=%lu ch1=float32 ch2=int32\n", seq_counter, now);
                float wave = 25.0f + (float)(seq_counter % 100u) * 0.05f;
                int32_t ramp = (int32_t)(seq_counter % 120u) - 60;
                uint32_t w1 = PS_WriteFloat(1, wave);
                uint32_t w2 = PS_WriteInt(2, ramp);
                if (n0 > 0) bytes_written += (uint32_t)n0; else drops++;
                if (w1 == sizeof(float)) bytes_written += w1; else drops++;
                if (w2 == sizeof(int32_t)) bytes_written += w2; else drops++;
                seq_counter++;
            }
            break;
        }
        default:
            // Idle — small delay to avoid burning cycles
            HAL_Delay(1);
            break;
        }

        // Toggle LED every ~100k iterations in active modes
        if (test_mode > 0 && ++led_tick >= 100000) {
            BSP_LED_Toggle(LED_GREEN);
            led_tick = 0;
        }
    }
}

void SystemClock_Config(void)
{
    RCC_OscInitTypeDef RCC_OscInitStruct = {0};
    RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

    if (HAL_RCCEx_EpodBoosterClkConfig(RCC_EPODBOOSTER_SOURCE_MSIS,
                                        RCC_EPODBOOSTER_DIV1) != HAL_OK)
        Error_Handler();
    if (HAL_PWREx_EnableEpodBooster() != HAL_OK)
        Error_Handler();
    if (HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1) != HAL_OK)
        Error_Handler();

    __HAL_FLASH_SET_LATENCY(FLASH_LATENCY_2);

    RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_MSIS;
    RCC_OscInitStruct.MSISState      = RCC_MSI_ON;
    RCC_OscInitStruct.MSISSource     = RCC_MSI_RC0;
    RCC_OscInitStruct.MSISDiv        = RCC_MSI_DIV1;
    if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
        Error_Handler();

    RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK  | RCC_CLOCKTYPE_SYSCLK
                                | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2
                                | RCC_CLOCKTYPE_PCLK3;
    RCC_ClkInitStruct.SYSCLKSource   = RCC_SYSCLKSOURCE_MSIS;
    RCC_ClkInitStruct.AHBCLKDivider  = RCC_SYSCLK_DIV1;
    RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
    RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;
    RCC_ClkInitStruct.APB3CLKDivider = RCC_HCLK_DIV1;
    if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2) != HAL_OK)
        Error_Handler();
}

void Error_Handler(void)
{
    __disable_irq();
    while (1) { }
}
