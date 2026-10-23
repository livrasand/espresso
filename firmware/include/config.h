#pragma once
#include <Arduino.h>

// ── Note: WiFi, server, and node identity are provisioned via captive portal ──
// and stored in NVS Preferences. No compile-time overrides needed.
// The macros below are kept only as fallbacks for non-provisioned builds.

// ── Node Protocol v2 timing ─────────────────────────
// HTTPS is used when the provisioned server port is 443 (Vercel
// production); any other port speaks plain HTTP for LAN/dev.

#define FIRMWARE_VERSION   "2.0.0"
#define POLL_INTERVAL_MS   1000   // poll cadence: telemetry + inbox drain
#define PAIR_RETRY_MS      15000  // re-post pair_request while unpaired (server TTL 10m)
#define WIFI_TIMEOUT_MS    20000
#define HTTP_TIMEOUT_MS    15000  // per-request read budget (must stay under the server's RPC_TIMEOUT_MS)

// ── SD card (VSPI) ──────────────────────────────────
#define SD_CS          5
#define SD_MOSI        23
#define SD_MISO        19
#define SD_CLK         18
#define SD_MOUNT_POINT "/sd"

// ── Internal flash (LittleFS) — fallback/overflow storage ────
#define FLASH_MOUNT_POINT  "/littlefs"

// ── CH375B USB host (UART serial mode) ────────────────
// Runtime auto-detected: storage.begin() always probes the chip via GET_IC_VER.
// The flag below only skips the USB probe entirely when explicitly set to false.
#define CH375B_RX          16      // ESP32 RX → CH375B TXD
#define CH375B_TX          17      // ESP32 TX → CH375B RXD
#define CH375B_INT         -1      // CH375B INT → GPIO27 (-1 = disabled for now)
#define CH375B_BAUD        9600    // CH375B default serial baud rate
#define CH375B_ENABLED     true    // true = always probe at runtime; false = skip USB entirely

// ── Provisioning indicator LED ───────────────────────
// Onboard LED of standard ESP32 DevKit boards.
#define LED_PROVISION_PIN       2
#define LED_PROVISION_BLINK_MS  250   // half-period of the fast blink
