cmake_minimum_required(VERSION 3.22)
enable_language(C ASM)

set(MX_Defines_Syms
    USE_NUCLEO_64
    USE_HAL_DRIVER
    STM32U385xx
    $<$<CONFIG:Debug>:DEBUG>
)

set(MX_Include_Dirs
    ${CMAKE_SOURCE_DIR}/Core/Inc
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Inc
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Inc/Legacy
    ${CMAKE_SOURCE_DIR}/Drivers/BSP/STM32U3xx_Nucleo
    ${CMAKE_SOURCE_DIR}/Drivers/CMSIS/Device/ST/STM32U3xx/Include
    ${CMAKE_SOURCE_DIR}/Drivers/CMSIS/Include
)

if(STRESS_TEST)
    set(MX_MAIN_SRC ${CMAKE_SOURCE_DIR}/Core/Src/main_stress.c)
else()
    set(MX_MAIN_SRC ${CMAKE_SOURCE_DIR}/Core/Src/main.c)
endif()

set(MX_Application_Src
    ${MX_MAIN_SRC}
    ${CMAKE_SOURCE_DIR}/Core/Src/gpio.c
    ${CMAKE_SOURCE_DIR}/Core/Src/stm32u3xx_it.c
    ${CMAKE_SOURCE_DIR}/Core/Src/stm32u3xx_hal_msp.c
    ${CMAKE_SOURCE_DIR}/Core/Src/sysmem.c
    ${CMAKE_SOURCE_DIR}/Core/Src/syscalls.c
    ${CMAKE_SOURCE_DIR}/startup_stm32u385xx.s
)

set(STM32_Drivers_Src
    ${CMAKE_SOURCE_DIR}/Core/Src/system_stm32u3xx.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_tim.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_tim_ex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_cortex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_rcc.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_rcc_ex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_flash.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_flash_ex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_gpio.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_dma.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_dma_ex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_exti.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_pwr.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_pwr_ex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_gtzc.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_icache.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_usart.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_usart_ex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_uart_ex.c
    ${CMAKE_SOURCE_DIR}/Drivers/STM32U3xx_HAL_Driver/Src/stm32u3xx_hal_uart.c
    ${CMAKE_SOURCE_DIR}/Drivers/BSP/STM32U3xx_Nucleo/stm32u3xx_nucleo.c
)

add_library(stm32cubemx INTERFACE)
target_include_directories(stm32cubemx INTERFACE ${MX_Include_Dirs})
target_compile_definitions(stm32cubemx INTERFACE ${MX_Defines_Syms})

add_library(STM32_Drivers OBJECT)
target_sources(STM32_Drivers PRIVATE ${STM32_Drivers_Src})
target_link_libraries(STM32_Drivers PUBLIC stm32cubemx)

target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${MX_Application_Src})
target_link_libraries(${CMAKE_PROJECT_NAME} STM32_Drivers)

set_target_properties(${CMAKE_PROJECT_NAME} PROPERTIES ADDITIONAL_CLEAN_FILES ${CMAKE_PROJECT_NAME}.map)

if((CMAKE_C_STANDARD EQUAL 90) OR (CMAKE_C_STANDARD EQUAL 99))
    message(ERROR "Generated code requires C11 or higher")
endif()
