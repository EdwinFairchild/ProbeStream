cmake_minimum_required(VERSION 3.22)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Debug")
endif()

set(CMAKE_PROJECT_NAME PS_Smoke_G4)

include("cmake/gcc-arm-none-eabi.cmake")
set(CMAKE_EXPORT_COMPILE_COMMANDS TRUE)

project(${CMAKE_PROJECT_NAME})
message("Build type: " ${CMAKE_BUILD_TYPE})

enable_language(C ASM)

add_executable(${CMAKE_PROJECT_NAME})

option(STRESS_TEST "Build stress test firmware" OFF)

add_subdirectory(cmake/stm32cubemx)

set(PROBESTREAM_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../target")

target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    ${PROBESTREAM_DIR}/probestream.c
)

target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
    ${PROBESTREAM_DIR}
)

target_link_libraries(${CMAKE_PROJECT_NAME}
    stm32cubemx
)
