export interface Config {
  strata: {
    url: string | null;
    token: string | null;
    timeoutMs: number;
  };
  secret: Buffer;
  apiKey: string;
  nodeOnlineTtlSec: number;
  rpcTimeoutMs: number;
  logFormat: "text" | "json";
  commitHash: string;
  sourceRepo: string;
}

function env(key: string): string | null {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : null;
}

function loadSecret(): Buffer {
  const raw = env("SESSION_SECRET");
  if (raw) {
    const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "utf8");
    if (hex.length >= 32) return hex.subarray(0, 32);
    return Buffer.from(raw.padEnd(32, "0"), "utf8").subarray(0, 32);
  }
  return crypto.createHash("sha256").update("espresso-dev-session-secret").digest();
}

import crypto from "node:crypto";

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;
  cached = {
    strata: {
      url: env("STRATA_URL"),
      token: env("STRATA_TOKEN"),
      timeoutMs: Math.max(1000, Number(env("STRATA_TIMEOUT_MS") ?? "20000") || 20000),
    },
    secret: loadSecret(),
    apiKey: env("ESPRESSO_API_KEY") ?? "",
    nodeOnlineTtlSec: Number(env("NODE_ONLINE_TTL") ?? "90") || 90,
    rpcTimeoutMs: Math.max(1000, Number(env("RPC_TIMEOUT_MS") ?? "90000") || 90000),
    logFormat: env("LOG_FORMAT") === "json" ? "json" : "text",
    commitHash: env("COMMIT_HASH") ?? "dev",
    sourceRepo: "https://github.com/livrasand/Espresso",
  };
  return cached;
}
