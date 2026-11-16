# Pirate Radio's firmware for an ESP32 board on the router's USB port: the
# chip's Bluetooth Low Energy radio, listening only, for pirate-bluetooth
# (main/main.c). Built with ESP-IDF 5.5:
#
#   idf.py set-target esp32c3 && idf.py build
#
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pirate-esp-firmware)
