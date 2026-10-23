// Environment configuration for the Espresso control plane.

export interface Config {
  redis: {
    url: string | null;
    token: string | null;
  };
  /** Secret for HMAC session tokens (serverless: must come from env). */
  secret: Buffer;
  /** Optional management API key (X-Espresso-Key). */
  apiKey: string;
  /** Seconds a node stays "online" without a poll. */
  nodeOnlineTtlSec: number;
  /** Max ms an RPC waits for the node's poll/response. */
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
  // serverless-safe fallback: instances cannot get a locally generated
  // cryptographically stable secret, so sessions would randomly fail. It is
  // only enabled if there is absolutely no dependency on cross-instance
  // sharing (local dev) — it is warned about in dev logs.
  return crypto.randomBytes(32);
}

import crypto from "node:crypto";

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;
  cached = {
    redis: {
      url: env("UPSTASH_REDIS_REST_URL"),
      token: env("UPSTASH_REDIS_REST_TOKEN"),
    },
    secret: loadSecret(),
    apiKey: env("ESPRESSO_API_KEY") ?? "",
    nodeOnlineTtlSec: Number(env("NODE_ONLINE_TTL") ?? "90") || 90,
    rpcTimeoutMs: Math.max(1000, Number(env("RPC_TIMEOUT_MS") ?? "15000") || 15000),
    logFormat: env("LOG_FORMAT") === "json" ? "json" : "text",
    commitHash: env("COMMIT_HASH") ?? "dev",
    sourceRepo: "https://github.com/livrasand/Espresso",
  };
  return cached;
}
