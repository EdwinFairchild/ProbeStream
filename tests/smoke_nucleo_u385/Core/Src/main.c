#include "main.h"
#include "gpio.h"
#include "probestream.h"

void SystemClock_Config(void);

static uint8_t ps_buffer[2048] __attribute__((aligned(4)));

int main(void)
{
    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();

    BSP_LED_Init(LED_GREEN);

    PS_Config_t ps_cfg = {
        .pBuffer        = ps_buffer,
        .bufferSize     = sizeof(ps_buffer),
        .numUpChannels  = 3,
        .numDownChannels = 1,
        .defaultMode    = PS_MODE_TRIM,
    };
    PS_Init(&ps_cfg);
    PS_SetChannelType(0, PS_CHANNEL_TYPE_TEXT);
    PS_SetChannelType(1, PS_CHANNEL_TYPE_FLOAT32);
    PS_SetChannelType(2, PS_CHANNEL_TYPE_INT32);

    uint32_t counter = 0;
    uint32_t delay_ms = 500;
    char cmd_buf[32];
    uint32_t cmd_pos = 0;

    while (1) {
        // Check down-channel for new delay value
        uint8_t rx[64];
        uint32_t n = PS_Read(0, rx, sizeof(rx));
        for (uint32_t i = 0; i < n; i++) {
            if (rx[i] == '\n' || rx[i] == '\r') {
                if (cmd_pos > 0) {
                    cmd_buf[cmd_pos] = '\0';
                    uint32_t val = 0;
                    for (uint32_t j = 0; cmd_buf[j] >= '0' && cmd_buf[j] <= '9'; j++)
                        val = val * 10 + (cmd_buf[j] - '0');
                    if (val > 0) {
                        delay_ms = val;
                        PS_Printf(0, "[delay changed to %lu ms]\n", delay_ms);
                    }
                    cmd_pos = 0;
                }
            } else if (cmd_pos < sizeof(cmd_buf) - 1) {
                cmd_buf[cmd_pos++] = rx[i];
            }
        }

        PS_Printf(0, "smoke %lu d=%lu\n", counter, delay_ms);
        PS_WriteFloat(1, 20.0f + (float)(counter % 100u) * 0.1f);
        PS_WriteInt(2, (int32_t)(counter % 80u) - 40);
        counter++;
        BSP_LED_Toggle(LED_GREEN);
        HAL_Delay(delay_ms);
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
