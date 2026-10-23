// Structured, privacy-preserving logger (port of internal/utils/logging.go).

import type { Config } from "./env.js";

let cfg: Config | null = null;

export function initLogger(c: Config): void {
  cfg = c;
  log("Privacy mode: Minimal logging enabled");
}

export function log(message: string): void {
  if (!cfg || cfg.logFormat !== "json") {
    console.log(`[Espresso] ${new Date().toISOString()} ${message}`);
    return;
  }
  const entry = {
    timestamp: new Date().toISOString(),
    level: "info",
    message,
    privacy: "anonymized",
  };
  console.log(JSON.stringify(entry));
}

export function logError(message: string): void {
  if (!cfg || cfg.logFormat !== "json") {
    console.log(`[Espresso] ${new Date().toISOString()} ERROR ${message}`);
    return;
  }
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error",
    message,
    privacy: "anonymized",
  };
  console.log(JSON.stringify(entry));
}
