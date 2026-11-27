#pragma once
#include <Arduino.h>

#define FIRMWARE_VERSION   "2.0.0"
#define POLL_INTERVAL_MS   3000
#define PAIR_RETRY_MS      15000
#define WIFI_TIMEOUT_MS    60000
#define HTTP_TIMEOUT_MS    60000

#define SD_CS          5
#define SD_MOSI        23
#define SD_MISO        19
#define SD_CLK         18
#define SD_MOUNT_POINT "/sd"

#define FLASH_MOUNT_POINT  "/littlefs"

#define CH375B_RX          16
#define CH375B_TX          17
#define CH375B_INT         -1
#define CH375B_BAUD        9600
#define CH375B_ENABLED     true

#define LED_PROVISION_PIN       2
#define LED_PROVISION_BLINK_MS  250
