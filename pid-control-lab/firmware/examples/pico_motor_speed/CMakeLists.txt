# Raspberry Pi Pico C SDK build skeleton (untested on hardware).
#   export PICO_SDK_PATH=/path/to/pico-sdk
#   mkdir build && cd build && cmake .. && make
cmake_minimum_required(VERSION 3.13)
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(pico_motor_speed C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

add_executable(pico_motor_speed main.c ../../pid.c)
target_include_directories(pico_motor_speed PRIVATE ../..)
target_link_libraries(pico_motor_speed pico_stdlib hardware_pwm)
pico_enable_stdio_usb(pico_motor_speed 1)
pico_add_extra_outputs(pico_motor_speed)
