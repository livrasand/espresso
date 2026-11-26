// Per-IP rate limiting, Redis-backed sliding window (port of
// prCheckWindowLimiter from internal/http/helpers.go, now Redis-based since
// serverless instances cannot share in-memory state).

import type { Redis } from "../redis/index.js";

export interface RateLimitOptions {
  keyPrefix: string;
  max: number;
  windowMs: number;
  /** identifies the client (e.g. IP); may itself be keyed by account. */
  id: string;
}

export async function consumeRateLimit(redis: Redis, opts: RateLimitOptions): Promise<"allow" | "reject"> {
  const key = `rl:${opts.keyPrefix}:${opts.id}`;
  const now = Date.now();
  const member = `${now.toString(16)}${Math.random().toString(16).slice(2)}`;
  const count = await redis.zwindow(key, now, member, opts.windowMs);
  return count > opts.max ? "reject" : "allow";
}
