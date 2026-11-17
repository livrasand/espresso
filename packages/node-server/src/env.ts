// Environment configuration for the Espresso control plane.

export interface Config {
  /** Strata KV store (git-backed). URL + API token; unset → in-memory dev store. */
  strata: {
    url: string | null;
    token: string | null;
    /** Hard cap (ms) per Strata HTTP round trip (see STRATA_TIMEOUT_MS). */
    timeoutMs: number;
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
  // Serverless-safe fallback: derive a stable secret deterministically so
  // that every instance agrees on the signing key even when SESSION_SECRET
  // is not configured. This keeps session tokens valid across cold starts
  // (a random per-instance key would invalidate every token on rotation).
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
      // Cap each Strata round trip so a hung upstream (Strata → Codeberg)
      // fails fast with a 500 instead of stalling until the serverless
      // maxDuration kills the lambda.
      timeoutMs: Math.max(1000, Number(env("STRATA_TIMEOUT_MS") ?? "20000") || 20000),
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
